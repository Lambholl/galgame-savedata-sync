import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  BATCH_LIMITS,
  SYNC_LIMITS,
  compareSyncPaths,
  isBatchFileId,
  isOpaqueId,
  isSyncBackupManifest,
  isSyncBackupSettings,
  isSyncPlan,
  isSyncSnapshot,
  syncPathKey,
} from '@savedata-sync/shared'
import type {
  KnownOperationError,
  SyncBackupFile,
  SyncBackupManifest,
  SyncBackupSettings,
  SyncEntry,
  SyncPlan,
  SyncSnapshot,
} from '@savedata-sync/shared'
import type { DirectoryFileRead, WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { FileIdentity } from './directory-paths.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import { ArchiveError, checkArchiveAbort, toArchiveError } from './archive-errors.ts'
import {
  BACKUP_DISK_IO,
  hashBackupStream,
  inspectBackupFile,
  openBackupFile,
  readBackupJson,
  writeBackupJson,
} from './backup-files.ts'
import type { BackupDiskIO } from './backup-files.ts'

type BackupSource = Pick<
  WindowsDirectoryAdapter,
  'deviceId' | 'assertCacheIsolated' | 'excludePrivateDirectory' | 'listDirectory' | 'openFile'
>
interface RoundMarker {
  readonly schemaVersion: 1
  readonly storeId: string
  readonly backupId: string
  readonly projectId: string
  readonly rootId: string
}
interface BackupRound {
  readonly marker: RoundMarker
  readonly identity: FileIdentity
  readonly manifest: SyncBackupManifest | null
}
/** 公开查询只提供当前项目的清单和需显式清理的轮次 ID，不暴露私有文件路径。 */
export interface WindowsBackupListing {
  readonly backups: readonly SyncBackupManifest[]
  readonly incomplete: readonly string[]
}
/** 清单提交成功后轮换错误单独报告；调用方仍可使用该有效备份保护写入。 */
export interface WindowsBackupCommit {
  readonly manifest: SyncBackupManifest | null
  readonly cleanupError: KnownOperationError | null
}
/** 原生调用可提供取消和收紧期限；备份参数不由网络或 Renderer 指定。 */
export interface WindowsBackupOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

const stores = new Set<string>()
const ROUND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function cleanupFailure(error: unknown): KnownOperationError {
  const failure = toArchiveError(error)
  return {
    code: 'cleanup-failed',
    message: '备份轮换或残留清理失败。',
    canRetry: false,
    ...(failure instanceof ArchiveError ? { message: failure.operationError.message } : {}),
  }
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new ArchiveError('invalid-request', '备份上下文不完整。')
  }
  return value
}
function targetFile(
  plan: SyncPlan,
  entryId: string | null,
): SyncEntry & { sizeBytes: number; sha256: string } {
  const entry = required(plan.target.entries.find((item) => item.entryId === entryId))
  if (entry.kind !== 'file' || entry.sizeBytes === null || entry.sha256 === null) {
    throw new ArchiveError('invalid-request', '被覆盖文件缺少完整内容指纹。')
  }
  return { ...entry, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }
}
function operationSignal(controller: AbortController, options: WindowsBackupOptions): AbortSignal {
  const timeoutMs = options.timeoutMs ?? SYNC_LIMITS.scanTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SYNC_LIMITS.scanTimeoutMs) {
    throw new ArchiveError('invalid-request', '备份期限无效。')
  }
  return AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ])
}
function group(projectId: string, rootId: string): void {
  if (!isOpaqueId(projectId) || !isOpaqueId(rootId)) {
    throw new ArchiveError('invalid-request', '备份项目或目录引用无效。')
  }
}
function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
async function exists(path: string): Promise<boolean> {
  try {
    await inspectLocalPath(path)
    return true
  } catch (error) {
    if (isMissing(error)) {
      return false
    }
    throw error
  }
}

/**
 * 已完整验证的恢复材料，引用期间不参加轮换；内容只通过原生流返回。
 * 消费者关闭全部读流后 release；snapshot 仅为本次恢复建立临时目录树。
 */
export class WindowsBackupHandle {
  private readonly readers = new Set<Readable>()
  private isReleased = false
  constructor(
    private readonly store: WindowsBackupStore,
    private readonly round: BackupRound,
  ) {}
  get manifest(): SyncBackupManifest {
    return structuredClone(required(this.round.manifest))
  }
  snapshot(): SyncSnapshot {
    if (this.isReleased) {
      throw new ArchiveError('not-found', '备份材料已释放。')
    }
    const manifest = this.manifest
    const entries = new Map<string, SyncEntry>()
    for (const file of manifest.files) {
      for (let depth = 1; depth < file.path.length; depth++) {
        const path = file.path.slice(0, depth),
          key = syncPathKey(path)
        if (!entries.has(key)) {
          if (entries.size >= SYNC_LIMITS.maxEntries) {
            throw new ArchiveError('resource-limit', '备份目录树超过恢复限制。')
          }
          entries.set(key, {
            entryId: `d${entries.size + 1}`,
            path,
            kind: 'directory',
            sizeBytes: null,
            sha256: null,
            modifiedAt: null,
            error: null,
          })
        }
      }
      if (entries.size >= SYNC_LIMITS.maxEntries) {
        throw new ArchiveError('resource-limit', '备份目录树超过恢复限制。')
      }
      entries.set(syncPathKey(file.path), {
        entryId: file.fileId,
        path: file.path,
        kind: 'file',
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        modifiedAt: file.modifiedAt,
        error: null,
      })
    }
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      scanId: randomUUID(),
      deviceId: manifest.deviceId,
      rootId: manifest.backupId,
      observedAt: Date.now(),
      error: null,
      entries: [...entries.values()].sort((a, b) => compareSyncPaths(a.path, b.path)),
    }
    if (!isSyncSnapshot(snapshot)) {
      throw new ArchiveError('resource-limit', '备份目录树超过恢复限制。')
    }
    return snapshot
  }
  /** 返回流的所有权交给消费者；实际写回还须按清单校验内容。 */
  async openFile(
    fileId: string,
  ): Promise<{ stream: Readable; verifyUnchanged: () => Promise<void> }> {
    if (this.isReleased) {
      throw new ArchiveError('not-found', '备份材料已释放。')
    }
    const file = required(this.round.manifest).files.find((item) => item.fileId === fileId)
    if (!file) {
      throw new ArchiveError('not-found', '备份文件引用不存在。')
    }
    await this.store.inspectRound(this.round)
    const value = await openBackupFile(
      join(this.store.path, this.round.marker.backupId, fileId),
      file.sizeBytes,
    )
    if (this.isReleased) {
      value.stream.destroy()
      await finished(value.stream).catch(() => {})
      throw new ArchiveError('not-found', '备份材料已释放。')
    }
    this.readers.add(value.stream)
    value.stream.once('close', () => this.readers.delete(value.stream))
    return {
      stream: value.stream,
      verifyUnchanged: async () => {
        await this.store.inspectRound(this.round)
        await value.verify()
      },
    }
  }
  /** 释放后重新尝试轮换；清理错误不改写备份或恢复结果。 */
  async release(): Promise<KnownOperationError | null> {
    if (this.readers.size) {
      throw new ArchiveError('busy', '请先关闭备份读流。')
    }
    if (this.isReleased) {
      return null
    }
    this.isReleased = true
    return this.store.release(this, this.round.marker)
  }
  /** 应用退出时关闭所持读流；普通释放仍要求消费者先结束读取。 */
  async close(): Promise<void> {
    const readers = [...this.readers]
    for (const reader of readers) {
      reader.destroy()
    }
    await Promise.all(readers.map((reader) => finished(reader).catch(() => {})))
    this.readers.clear()
    await this.release()
  }
}

/**
 * Windows 私有持久备份。元数据/创建/轮换串行，恢复材料通过引用保护。
 * 只读同步根，写入固定私有文件名；失败提交前不产生可恢复轮次。
 * 用法及错误/清理语义见桌面 README；仅通过工厂初始化。
 */
export class WindowsBackupStore {
  private queue: Promise<void> = Promise.resolve()
  private readonly handles = new Map<WindowsBackupHandle, string>()
  private active: AbortController | null = null
  private stopping: Promise<void> | null = null
  private isClosed = false
  constructor(
    private readonly source: BackupSource,
    readonly path: string,
    private readonly storeId: string,
    private readonly identity: FileIdentity,
    private readonly io: BackupDiskIO,
  ) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue
      .then(() => {
        if (this.isClosed) {
          throw new ArchiveError('busy', '备份存储已关闭。')
        }
        return work()
      })
      .catch((error: unknown) => {
        throw toArchiveError(error)
      })
    this.queue = next.then(
      () => {},
      () => {},
    )
    return next
  }
  private async inspect(): Promise<void> {
    this.source.assertCacheIsolated(this.path)
    if (!hasSameIdentity(await inspectLocalPath(this.path), this.identity)) {
      throw new ArchiveError('source-changed', '备份目录身份已变化。')
    }
    const marker = await readBackupJson(join(this.path, 'owner.json'))
    if (
      !marker ||
      typeof marker !== 'object' ||
      !('storeId' in marker) ||
      marker.storeId !== this.storeId ||
      !('deviceId' in marker) ||
      marker.deviceId !== this.source.deviceId ||
      !('schemaVersion' in marker) ||
      marker.schemaVersion !== 1 ||
      Object.keys(marker).length !== 3
    ) {
      throw new ArchiveError('permission-denied', '备份目录归属无效。')
    }
  }
  /** 同包恢复句柄每次读取前核对根、轮次身份和所有权。 */
  async inspectRound(round: BackupRound, hasMarker = true): Promise<void> {
    await this.inspect()
    const path = join(this.path, round.marker.backupId)
    if (
      !hasSameIdentity(await inspectLocalPath(path), round.identity) ||
      (hasMarker &&
        JSON.stringify(await readBackupJson(join(path, 'round.json'))) !==
          JSON.stringify(round.marker))
    ) {
      throw new ArchiveError('source-changed', '备份轮次身份或归属已变化。')
    }
  }
  private async rounds(): Promise<BackupRound[]> {
    await this.inspect()
    const result: BackupRound[] = [],
      names = await readdir(this.path)
    if (names.length > 4096) {
      throw new ArchiveError('resource-limit', '备份轮次数量超过限制。')
    }
    for (const name of names) {
      if (
        ['owner.json', 'settings.json'].includes(name) ||
        /^settings-[0-9a-f-]+\.tmp$/.test(name)
      ) {
        continue
      }
      if (!ROUND_ID.test(name)) {
        throw new ArchiveError('invalid-request', '备份目录含未知条目，请手工检查。')
      }
      const path = join(this.path, name),
        stats = await inspectLocalPath(path)
      if (!stats.isDirectory()) {
        throw new ArchiveError('invalid-request', '备份轮次不是目录。')
      }
      const marker: unknown = await readBackupJson(join(path, 'round.json'))
      if (
        !marker ||
        typeof marker !== 'object' ||
        !('schemaVersion' in marker) ||
        marker.schemaVersion !== 1 ||
        !('storeId' in marker) ||
        marker.storeId !== this.storeId ||
        !('backupId' in marker) ||
        marker.backupId !== name ||
        !('projectId' in marker) ||
        !isOpaqueId(marker.projectId) ||
        !('rootId' in marker) ||
        !isOpaqueId(marker.rootId) ||
        Object.keys(marker).length !== 5
      ) {
        throw new ArchiveError('permission-denied', '备份轮次归属无效。')
      }
      let manifest: SyncBackupManifest | null = null
      if (await exists(join(path, 'manifest.json'))) {
        const value = await readBackupJson(join(path, 'manifest.json'))
        if (
          !isSyncBackupManifest(value) ||
          value.backupId !== name ||
          value.deviceId !== this.source.deviceId ||
          value.projectId !== marker.projectId ||
          value.rootId !== marker.rootId
        ) {
          throw new ArchiveError('invalid-archive', '备份清单损坏或归属不符。')
        }
        manifest = value
      }
      if (manifest && (await exists(join(path, 'manifest.retired')))) {
        throw new ArchiveError('invalid-archive', '备份提交状态冲突。')
      }
      result.push({ marker: marker as RoundMarker, identity: getFileIdentity(stats), manifest })
    }
    return result
  }
  /** 列表表示已提交的清单；恢复前 acquire 将重新核对每个文件。 */
  list(projectId: string, rootId: string): Promise<WindowsBackupListing> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const rounds = (await this.rounds()).filter(
        (round) => round.marker.projectId === projectId && round.marker.rootId === rootId,
      )
      return {
        backups: rounds
          .flatMap((round) => (round.manifest ? [round.manifest] : []))
          .sort((a, b) => b.createdAt - a.createdAt),
        incomplete: rounds.filter((round) => !round.manifest).map((round) => round.marker.backupId),
      }
    })
  }
  /** 缺少文件时备份默认开启；坏设置不会被默认值覆盖。 */
  settings(): Promise<SyncBackupSettings> {
    return this.exclusive(() => this.readSettings())
  }
  private async readSettings(): Promise<SyncBackupSettings> {
    await this.inspect()
    if (!(await exists(join(this.path, 'settings.json')))) {
      return { schemaVersion: 1, projects: [] }
    }
    const value = await readBackupJson(join(this.path, 'settings.json'))
    if (!isSyncBackupSettings(value)) {
      throw new ArchiveError('invalid-request', '备份设置损坏。')
    }
    return value
  }
  /** 独立于 LibraryConfig v1；false 只影响普通复制，恢复保护由计划器强制开启。 */
  setPreference(
    projectId: string,
    rootId: string,
    shouldBackup: boolean,
  ): Promise<SyncBackupSettings> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const previous = await this.readSettings()
      const settings = {
        schemaVersion: 1,
        projects: [
          ...previous.projects.filter(
            (item) => item.projectId !== projectId || item.rootId !== rootId,
          ),
          { projectId, rootId, shouldBackup },
        ],
      } as const
      if (!isSyncBackupSettings(settings)) {
        throw new ArchiveError('resource-limit', '备份设置超过限制。')
      }
      const temporary = join(this.path, `settings-${randomUUID()}.tmp`)
      try {
        await writeBackupJson(temporary, settings, this.io)
        await this.inspect()
        await rename(temporary, join(this.path, 'settings.json'))
      } catch (error) {
        const failure = toArchiveError(error)
        try {
          if (await exists(temporary)) {
            await this.inspect()
            await inspectBackupFile(temporary, BATCH_LIMITS.maxJsonBytes)
            await unlink(temporary)
          }
        } catch (cleanup) {
          failure.cleanupError = cleanupFailure(cleanup)
        }
        throw failure
      }
      return settings
    })
  }
  /** 容量包含完整新轮及清单，旧有效备份保持到新轮提交后；不提前释放旧备份换空间。 */
  async capacity(
    requiredBytes: number,
  ): Promise<{ requiredBytes: number; availableBytes: number | null }> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
      throw new ArchiveError('invalid-request', '备份容量无效。')
    }
    await this.inspect()
    const available = await this.io.availableBytes(this.path)
    if (available !== null && available < BigInt(requiredBytes)) {
      throw new ArchiveError('insufficient-space', '覆盖前备份空间不足。')
    }
    return {
      requiredBytes,
      availableBytes:
        available === null
          ? null
          : Number(
              available > BigInt(Number.MAX_SAFE_INTEGER)
                ? BigInt(Number.MAX_SAFE_INTEGER)
                : available,
            ),
    }
  }
  private async sourceFile(
    plan: SyncPlan,
    entry: SyncEntry,
    signal: AbortSignal,
  ): Promise<DirectoryFileRead> {
    let parentId: string | null = null
    for (const [index, name] of entry.path.entries()) {
      checkArchiveAbort(signal)
      const listed = await this.source.listDirectory(plan.target.rootId, parentId)
      if (listed.status === 'error') {
        throw toArchiveError({ operationError: listed.error })
      }
      const matches = listed.value.entries.filter((item) => item.name === name)
      if (matches.length !== 1) {
        throw new ArchiveError('source-changed', '被覆盖文件的目录或名称已变化。')
      }
      const current = required(matches[0])
      if (index < entry.path.length - 1) {
        if (current.kind !== 'directory') {
          throw new ArchiveError('source-changed', '被覆盖文件的父目录已变化。')
        }
        parentId = current.entryId
      } else if (current.entryId !== entry.entryId || current.kind !== 'file') {
        throw new ArchiveError('source-changed', '被覆盖文件身份已变化。')
      }
    }
    const opened = await this.source.openFile({
      rootId: plan.target.rootId,
      entryId: entry.entryId,
    })
    if (opened.status === 'error') {
      throw toArchiveError({ operationError: opened.error })
    }
    const { stream, metadata } = opened.value
    try {
      if (metadata.sizeBytes !== entry.sizeBytes || metadata.modifiedAt !== entry.modifiedAt) {
        throw new ArchiveError('source-changed', '被覆盖文件属性已变化。')
      }
      return opened.value
    } catch (error) {
      stream.destroy()
      await finished(stream).catch(() => {})
      throw error
    }
  }
  /** 只保存有效计划中将被替换的旧内容；返回 null 表示无备份轮次，绝不写同步目标。 */
  create(plan: SyncPlan, options: WindowsBackupOptions = {}): Promise<WindowsBackupCommit> {
    if (!isSyncPlan(plan) || !plan.canExecute || plan.target.deviceId !== this.source.deviceId) {
      throw new ArchiveError('invalid-request', '备份计划无效或目标设备不符。')
    }
    const fixed = structuredClone(plan)
    return this.exclusive(async () => {
      const controller = new AbortController(),
        signal = operationSignal(controller, options)
      this.active = controller
      let round: BackupRound | null = null,
        hasCommitted = false,
        hasMarker = false
      try {
        checkArchiveAbort(signal)
        const rounds = await this.rounds()
        if (!fixed.shouldBackup) {
          return { manifest: null, cleanupError: null }
        }
        const replacements = fixed.entries.filter((entry) => entry.action === 'replace-file')
        if (!replacements.length) {
          return { manifest: null, cleanupError: null }
        }
        if (rounds.some((item) => !item.manifest)) {
          throw new ArchiveError('cleanup-failed', '请先清理未完成的备份轮次。')
        }
        const files: SyncBackupFile[] = replacements.map((entry, index) => {
          const target = targetFile(fixed, entry.targetEntryId)
          return {
            fileId: `f${String(index + 1).padStart(6, '0')}`,
            path: target.path,
            sizeBytes: target.sizeBytes,
            sha256: target.sha256,
            modifiedAt: target.modifiedAt,
          }
        })
        const backupId = randomUUID(),
          manifest: SyncBackupManifest = {
            schemaVersion: 1,
            backupId,
            projectId: fixed.projectId,
            deviceId: this.source.deviceId,
            rootId: fixed.target.rootId,
            createdAt: Math.max(
              Date.now(),
              ...rounds.filter((r) => r.manifest).map((r) => required(r.manifest).createdAt + 1),
            ),
            reason: fixed.operation,
            files,
          }
        if (!isSyncBackupManifest(manifest)) {
          throw new ArchiveError('resource-limit', '备份清单超过格式或资源限制。')
        }
        await this.capacity(
          files.reduce((total, file) => total + file.sizeBytes, 0) +
            Buffer.byteLength(JSON.stringify(manifest)) +
            4096,
        )
        const path = join(this.path, backupId)
        checkArchiveAbort(signal)
        await mkdir(path, { mode: 0o700 })
        const marker: RoundMarker = {
          schemaVersion: 1,
          storeId: this.storeId,
          backupId,
          projectId: fixed.projectId,
          rootId: fixed.target.rootId,
        }
        round = { marker, identity: getFileIdentity(await inspectLocalPath(path)), manifest: null }
        await writeBackupJson(join(path, 'round.json'), marker, this.io)
        hasMarker = true
        for (const [index, file] of files.entries()) {
          const target = targetFile(fixed, required(replacements[index]).targetEntryId)
          await this.inspectRound(round)
          checkArchiveAbort(signal)
          const source = await this.sourceFile(fixed, target, signal),
            input = source.stream
          let output: FileHandle | undefined
          try {
            const destination = await open(join(path, file.fileId), 'wx', 0o600)
            output = destination
            const value = await hashBackupStream(input, file.sizeBytes, signal, async (chunk) => {
              for (let offset = 0; offset < chunk.length;) {
                checkArchiveAbort(signal)
                const written = await destination.write(chunk, offset, chunk.length - offset)
                if (written.bytesWritten === 0) {
                  throw new ArchiveError('io-failure', '备份写入没有进展。')
                }
                offset += written.bytesWritten
              }
            })
            if (value.sizeBytes !== file.sizeBytes || value.sha256 !== file.sha256) {
              throw new ArchiveError('source-changed', '被覆盖文件内容已变化。')
            }
            await source.verifyUnchanged()
            await this.io.sync(output)
          } finally {
            input.destroy()
            await finished(input).catch(() => {})
            await output?.close()
          }
          await this.verifyFile(round, file, signal)
        }
        checkArchiveAbort(signal)
        await this.inspectRound(round)
        await writeBackupJson(join(path, 'manifest.pending'), manifest, this.io)
        checkArchiveAbort(signal)
        await rename(join(path, 'manifest.pending'), join(path, 'manifest.json'))
        hasCommitted = true
        let cleanupError: KnownOperationError | null = null
        try {
          await this.prune(fixed.projectId, fixed.target.rootId, signal)
        } catch (error) {
          cleanupError = cleanupFailure(error)
        }
        return { manifest, cleanupError }
      } catch (error) {
        const failure = toArchiveError(error, signal)
        if (round && !hasCommitted) {
          try {
            await this.remove(round, hasMarker)
          } catch (cleanup) {
            failure.cleanupError = cleanupFailure(cleanup)
          }
        }
        throw failure
      } finally {
        this.active = null
      }
    })
  }
  private async verifyFile(
    round: BackupRound,
    file: SyncBackupFile,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.inspectRound(round)
    const input = await openBackupFile(
      join(this.path, round.marker.backupId, file.fileId),
      BATCH_LIMITS.maxFileBytes,
    )
    const value = await hashBackupStream(input.stream, file.sizeBytes, signal)
    await input.verify()
    if (value.sizeBytes !== file.sizeBytes || value.sha256 !== file.sha256) {
      throw new ArchiveError('checksum-mismatch', '备份内容校验失败。')
    }
  }
  private async remove(round: BackupRound, hasMarker = true): Promise<void> {
    await this.inspectRound(round, hasMarker)
    if ([...this.handles.values()].includes(round.marker.backupId)) {
      throw new ArchiveError('busy', '备份正在用于恢复。')
    }
    const path = join(this.path, round.marker.backupId),
      names = await readdir(path)
    const identities = new Map<string, FileIdentity>()
    for (const name of names) {
      if (
        !['round.json', 'manifest.json', 'manifest.pending', 'manifest.retired'].includes(name) &&
        !isBatchFileId(name)
      ) {
        throw new ArchiveError('cleanup-failed', '备份含未知文件，停止清理。')
      }
      identities.set(
        name,
        await inspectBackupFile(
          join(path, name),
          name.startsWith('f') ? BATCH_LIMITS.maxFileBytes : BATCH_LIMITS.maxJsonBytes,
        ),
      )
    }
    if (names.includes('manifest.json')) {
      await rename(join(path, 'manifest.json'), join(path, 'manifest.retired'))
      identities.set('manifest.retired', required(identities.get('manifest.json')))
      identities.delete('manifest.json')
    }
    // 所有内容先验明归属；最后才删所有权记录，失败保留可重试的轮次。
    for (const name of [...identities.keys()].filter((name) => name !== 'round.json')) {
      await this.inspectRound(round, hasMarker)
      if (
        !hasSameIdentity(await inspectLocalPath(join(path, name)), required(identities.get(name)))
      ) {
        throw new ArchiveError('cleanup-failed', '清理时备份文件身份变化。')
      }
      await unlink(join(path, name))
    }
    await this.inspectRound(round, hasMarker)
    if (identities.has('round.json')) {
      await unlink(join(path, 'round.json'))
    }
    try {
      await rmdir(path)
    } catch (error) {
      await this.inspectRound(round, false)
      await writeBackupJson(join(path, 'round.json'), round.marker, this.io)
      throw error
    }
  }
  private async prune(
    projectId: string,
    rootId: string,
    signal = AbortSignal.timeout(SYNC_LIMITS.scanTimeoutMs),
  ): Promise<void> {
    const rounds = (await this.rounds())
      .filter(
        (round) =>
          round.manifest && round.marker.projectId === projectId && round.marker.rootId === rootId,
      )
      .sort((a, b) => required(b.manifest).createdAt - required(a.manifest).createdAt)
    if (rounds.length <= SYNC_LIMITS.backupRetention) {
      return
    }
    for (const round of rounds.slice(0, SYNC_LIMITS.backupRetention)) {
      for (const file of required(round.manifest).files) {
        await this.verifyFile(round, file, signal)
      }
    }
    for (const round of rounds.slice(SYNC_LIMITS.backupRetention)) {
      if (![...this.handles.values()].includes(round.marker.backupId)) {
        await this.remove(round)
      }
    }
  }
  /** 恢复前完整复核；获取引用后才允许轮换其他轮次，不发布任何目标文件。 */
  acquire(
    projectId: string,
    rootId: string,
    backupId: string,
    options: WindowsBackupOptions = {},
  ): Promise<WindowsBackupHandle> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      if (this.handles.size >= 32) {
        throw new ArchiveError('resource-limit', '备份读取引用过多。')
      }
      const round = (await this.rounds()).find(
        (item) =>
          item.manifest &&
          item.marker.backupId === backupId &&
          item.marker.projectId === projectId &&
          item.marker.rootId === rootId,
      )
      if (!round) {
        throw new ArchiveError('not-found', '备份不存在或不属于该项目目录。')
      }
      const controller = new AbortController(),
        signal = operationSignal(controller, options)
      const handle = new WindowsBackupHandle(this, round)
      this.handles.set(handle, backupId)
      this.active = controller
      try {
        handle.snapshot()
        for (const file of required(round.manifest).files) {
          await this.verifyFile(round, file, signal)
        }
        return handle
      } catch (error) {
        this.handles.delete(handle)
        throw toArchiveError(error, signal)
      } finally {
        this.active = null
      }
    })
  }
  /** 同包句柄释放引用后轮换；主错误与轮换错误由调用方分别显示。 */
  async release(
    handle: WindowsBackupHandle,
    marker: RoundMarker,
  ): Promise<KnownOperationError | null> {
    this.handles.delete(handle)
    if (this.isClosed) {
      return null
    }
    try {
      await this.exclusive(() => this.prune(marker.projectId, marker.rootId))
      return null
    } catch (error) {
      return cleanupFailure(error)
    }
  }
  /** 显式重试轮换，不删除受引用保护或尚未完成的轮次。 */
  rotate(projectId: string, rootId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(() => this.prune(projectId, rootId))
  }
  /** 只清理经所有权核实的未提交/已淘汰轮次；不可通过此入口删除有效备份。 */
  cleanupIncomplete(projectId: string, rootId: string, backupId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const round = (await this.rounds()).find(
        (item) =>
          item.marker.backupId === backupId &&
          item.marker.projectId === projectId &&
          item.marker.rootId === rootId,
      )
      if (!round) {
        throw new ArchiveError('not-found', '未完成备份不存在。')
      }
      if (round.manifest) {
        throw new ArchiveError('permission-denied', '有效备份通过轮换保留，不能当作残留清理。')
      }
      await this.remove(round)
    })
  }
  /** 应用退出取消创建并关闭恢复流；备份目录和已提交轮次保留供下次启动查询。 */
  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping
    }
    this.isClosed = true
    this.active?.abort()
    this.stopping = this.finishStop()
    return this.stopping
  }
  private async finishStop(): Promise<void> {
    await this.queue
    for (const handle of [...this.handles.keys()]) {
      await handle.close()
    }
    stores.delete(this.path)
  }
}

/** 初始化 userData/backups，要求应用私有路径已解析；已有数据只按独立 v1 格式读取。 */
export async function createWindowsBackupStore(
  source: BackupSource,
  privateDirectory: string,
  io: Partial<BackupDiskIO> = {},
): Promise<WindowsBackupStore> {
  if (!isAbsolute(privateDirectory) || !isOpaqueId(source.deviceId)) {
    throw new ArchiveError('invalid-request', '备份初始化参数无效。')
  }
  await inspectLocalPath(privateDirectory)
  const path = join(privateDirectory, 'backups')
  source.assertCacheIsolated(path)
  if (stores.has(path)) {
    throw new ArchiveError('busy', '该备份存储已打开。')
  }
  stores.add(path)
  const disk = { ...BACKUP_DISK_IO, ...io }
  try {
    if (!(await exists(path))) {
      await mkdir(path, { mode: 0o700 })
    }
    const stats = await inspectLocalPath(path)
    if (!stats.isDirectory()) {
      throw new ArchiveError('invalid-request', '备份位置不是目录。')
    }
    if (!(await exists(join(path, 'owner.json')))) {
      if ((await readdir(path)).length) {
        throw new ArchiveError('permission-denied', '备份目录非空且缺少归属记录。')
      }
      await writeBackupJson(
        join(path, 'owner.json'),
        { schemaVersion: 1, storeId: randomUUID(), deviceId: source.deviceId },
        disk,
      )
    }
    const owner = await readBackupJson(join(path, 'owner.json'))
    if (
      !owner ||
      typeof owner !== 'object' ||
      !('storeId' in owner) ||
      !isOpaqueId(owner.storeId) ||
      !('schemaVersion' in owner) ||
      owner.schemaVersion !== 1 ||
      !('deviceId' in owner) ||
      owner.deviceId !== source.deviceId ||
      Object.keys(owner).length !== 3
    ) {
      throw new ArchiveError('permission-denied', '备份归属记录无效。')
    }
    source.excludePrivateDirectory(path)
    return new WindowsBackupStore(source, path, owner.storeId, getFileIdentity(stats), disk)
  } catch (error) {
    stores.delete(path)
    throw toArchiveError(error)
  }
}
