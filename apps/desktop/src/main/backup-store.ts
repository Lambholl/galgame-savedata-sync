import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  BATCH_LIMITS,
  EMPTY_BACKUP_SETTINGS,
  SYNC_LIMITS,
  compareSyncPaths,
  isBatchFileId,
  isOpaqueId,
  isSyncBackupManifest,
  isSyncBackupSettings,
  isSyncPlan,
  isSyncSnapshot,
  resolveBackupPolicy,
  selectSyncBackupFiles,
  syncPathKey,
  withBackupDefaults,
  withBackupPreference,
  withoutGameBackups,
} from '@savedata-sync/shared'
import type {
  KnownOperationError,
  SyncBackupFile,
  SyncBackupManifest,
  SyncBackupPolicy,
  SyncBackupSettings,
  SyncIncompleteBackup,
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
/** 备份查询结果：当前项目的清单和需要显式清理的轮次，不含私有文件路径。 */
export interface WindowsBackupListing {
  readonly backups: readonly SyncBackupManifest[]
  readonly incomplete: readonly SyncIncompleteBackup[]
}
/** 创建备份的结果：清单提交成功后的轮换错误单独报告，调用方仍可使用这份有效备份保护写入。 */
export interface WindowsBackupCommit {
  readonly manifest: SyncBackupManifest | null
  readonly cleanupError: KnownOperationError | null
}
/** 创建备份的选项，可以提供取消和更短的期限；备份参数不能由网络或渲染进程指定。 */
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
    message: 'Backup rotation or leftover cleanup failed.',
    canRetry: false,
    ...(failure instanceof ArchiveError ? { message: failure.operationError.message } : {}),
  }
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new ArchiveError('invalid-request', 'The backup context is incomplete.')
  }
  return value
}
function targetFile(
  plan: SyncPlan,
  entryId: string | null,
): SyncEntry & { sizeBytes: number; sha256: string } {
  const entry = required(plan.target.entries.find((item) => item.entryId === entryId))
  if (entry.kind !== 'file' || entry.sizeBytes === null || entry.sha256 === null) {
    throw new ArchiveError(
      'invalid-request',
      'A file to be backed up lacks a complete content fingerprint.',
    )
  }
  return { ...entry, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }
}
function operationSignal(controller: AbortController, options: WindowsBackupOptions): AbortSignal {
  const timeoutMs = options.timeoutMs ?? SYNC_LIMITS.scanTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SYNC_LIMITS.scanTimeoutMs) {
    throw new ArchiveError('invalid-request', 'The backup deadline is invalid.')
  }
  return AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ])
}
function group(projectId: string, rootId: string): void {
  if (!isOpaqueId(projectId) || !isOpaqueId(rootId)) {
    throw new ArchiveError(
      'invalid-request',
      'The backup project or directory reference is invalid.',
    )
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
 * 已完整校验的恢复材料。持有引用期间这一轮不参加轮换，内容只通过主进程内的流返回。
 * 消费者关闭全部读流后调用 release；snapshot 只为这次恢复建立临时目录树。
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
      throw new ArchiveError('not-found', 'The backup material has been released.')
    }
    const manifest = this.manifest
    const entries = new Map<string, SyncEntry>()
    for (const file of manifest.files) {
      for (let depth = 1; depth < file.path.length; depth++) {
        const path = file.path.slice(0, depth),
          key = syncPathKey(path)
        if (!entries.has(key)) {
          if (entries.size >= SYNC_LIMITS.maxEntries) {
            throw new ArchiveError(
              'resource-limit',
              'The backup directory tree exceeds restore limits.',
            )
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
        throw new ArchiveError(
          'resource-limit',
          'The backup directory tree exceeds restore limits.',
        )
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
      throw new ArchiveError('resource-limit', 'The backup directory tree exceeds restore limits.')
    }
    return snapshot
  }
  /** 打开备份里的文件，返回的流归消费者所有；实际写回时还要按清单校验内容。 */
  async openFile(
    fileId: string,
  ): Promise<{ stream: Readable; verifyUnchanged: () => Promise<void> }> {
    if (this.isReleased) {
      throw new ArchiveError('not-found', 'The backup material has been released.')
    }
    const file = required(this.round.manifest).files.find((item) => item.fileId === fileId)
    if (!file) {
      throw new ArchiveError('not-found', 'The backup file reference does not exist.')
    }
    await this.store.inspectRound(this.round)
    const value = await openBackupFile(
      join(this.store.path, this.round.marker.backupId, fileId),
      file.sizeBytes,
    )
    if (this.isReleased) {
      value.stream.destroy()
      await finished(value.stream).catch(() => {})
      throw new ArchiveError('not-found', 'The backup material has been released.')
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
  /** 释放引用后重新尝试轮换；清理错误不改变备份或恢复的结果。 */
  async release(): Promise<KnownOperationError | null> {
    if (this.readers.size) {
      throw new ArchiveError('busy', 'Close backup read streams first.')
    }
    if (this.isReleased) {
      return null
    }
    this.isReleased = true
    return this.store.release(this, this.round.marker)
  }
  /** 应用退出时关闭所持读流；正常释放仍要求消费者先读完。 */
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
 * Windows 的私有持久备份。元数据操作、创建和轮换串行执行，恢复材料通过引用保护。
 * 只读同步根，写入固定的私有文件名；提交失败时不会产生可恢复的轮次。
 * 用法及错误和清理语义见桌面 README；通过工厂函数初始化。
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
          throw new ArchiveError('busy', 'The backup store is closed.')
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
      throw new ArchiveError('source-changed', 'The backup directory identity changed.')
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
      throw new ArchiveError('permission-denied', 'The backup directory ownership is invalid.')
    }
  }
  /** 读取前核对根目录、轮次身份和所有权；同包的恢复句柄每次读取前都调用。 */
  async inspectRound(round: BackupRound, hasMarker = true): Promise<void> {
    await this.inspect()
    const path = join(this.path, round.marker.backupId)
    if (
      !hasSameIdentity(await inspectLocalPath(path), round.identity) ||
      (hasMarker &&
        JSON.stringify(await readBackupJson(join(path, 'round.json'))) !==
          JSON.stringify(round.marker))
    ) {
      throw new ArchiveError('source-changed', 'The backup version identity or ownership changed.')
    }
  }
  private async rounds(): Promise<BackupRound[]> {
    await this.inspect()
    const result: BackupRound[] = [],
      names = await readdir(this.path)
    if (names.length > 4096) {
      throw new ArchiveError('resource-limit', 'The number of backup versions exceeds the limit.')
    }
    for (const name of names) {
      if (
        ['owner.json', 'settings.json'].includes(name) ||
        /^settings-[0-9a-f-]+\.tmp$/.test(name)
      ) {
        continue
      }
      if (!ROUND_ID.test(name)) {
        throw new ArchiveError(
          'invalid-request',
          'The backup directory contains unknown entries. Inspect it manually.',
        )
      }
      const path = join(this.path, name),
        stats = await inspectLocalPath(path)
      if (!stats.isDirectory()) {
        throw new ArchiveError('invalid-request', 'The backup version is not a directory.')
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
        throw new ArchiveError('permission-denied', 'The backup version ownership is invalid.')
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
          throw new ArchiveError(
            'invalid-archive',
            'The backup manifest is damaged or its ownership does not match.',
          )
        }
        manifest = value
      }
      if (manifest && (await exists(join(path, 'manifest.retired')))) {
        throw new ArchiveError('invalid-archive', 'The backup commit state conflicts.')
      }
      result.push({ marker: marker as RoundMarker, identity: getFileIdentity(stats), manifest })
    }
    return result
  }
  /** 列出已提交的备份清单；恢复前 acquire 会重新核对每个文件。 */
  list(projectId: string, rootId: string): Promise<WindowsBackupListing> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const rounds = (await this.rounds()).filter(
        (round) => round.marker.projectId === projectId && round.marker.rootId === rootId,
      )
      const incomplete: SyncIncompleteBackup[] = []
      for (const round of rounds) {
        if (!round.manifest) {
          incomplete.push({
            backupId: round.marker.backupId,
            occupiedBytes: await this.occupiedBytes(round),
          })
        }
      }
      return {
        backups: rounds
          .flatMap((round) => (round.manifest ? [round.manifest] : []))
          .sort((a, b) => b.createdAt - a.createdAt),
        incomplete,
      }
    })
  }
  /** 一轮私有目录占用的字节数；读取失败时未知，由界面单独显示。 */
  private async occupiedBytes(round: BackupRound): Promise<number | null> {
    try {
      const path = join(this.path, round.marker.backupId)
      let total = 0
      for (const name of await readdir(path)) {
        total += Number((await inspectLocalPath(join(path, name))).size)
      }
      return total
    } catch {
      return null
    }
  }
  /** 读取备份设置。缺少文件时用默认全局设置；坏设置不会被默认值覆盖。 */
  settings(): Promise<SyncBackupSettings> {
    return this.exclusive(() => this.readSettings())
  }
  private async readSettings(): Promise<SyncBackupSettings> {
    await this.inspect()
    if (!(await exists(join(this.path, 'settings.json')))) {
      return EMPTY_BACKUP_SETTINGS
    }
    const value = await readBackupJson(join(this.path, 'settings.json'))
    if (!isSyncBackupSettings(value)) {
      throw new ArchiveError('invalid-request', 'Backup settings are damaged.')
    }
    return value
  }
  /** 单独设置某个游戏目录；null 改回跟随全局。关闭备份只影响普通复制，恢复时计划器强制开启保护。 */
  setPreference(
    projectId: string,
    rootId: string,
    policy: SyncBackupPolicy | null,
  ): Promise<SyncBackupSettings> {
    group(projectId, rootId)
    return this.exclusive(async () =>
      this.writeSettings(
        withBackupPreference(await this.readSettings(), projectId, rootId, policy),
      ),
    )
  }
  /** 修改全局设置；单独设置的游戏目录不受影响。 */
  setDefaults(policy: SyncBackupPolicy): Promise<SyncBackupSettings> {
    return this.exclusive(async () =>
      this.writeSettings(withBackupDefaults(await this.readSettings(), policy)),
    )
  }
  private async writeSettings(settings: SyncBackupSettings): Promise<SyncBackupSettings> {
    if (!isSyncBackupSettings(settings)) {
      throw new ArchiveError('resource-limit', 'Backup settings are invalid or exceed the limit.')
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
  }
  /** 比较备份目录的可用空间和调用方给出的字节数，不够时报 insufficient-space；可用空间未知时放行。不删除旧备份腾空间。 */
  async capacity(
    requiredBytes: number,
  ): Promise<{ requiredBytes: number; availableBytes: number | null }> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
      throw new ArchiveError('invalid-request', 'The backup capacity is invalid.')
    }
    await this.inspect()
    const available = await this.io.availableBytes(this.path)
    if (available !== null && available < BigInt(requiredBytes)) {
      throw new ArchiveError(
        'insufficient-space',
        'Space is insufficient for a backup before writing.',
      )
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
        throw new ArchiveError(
          'source-changed',
          'The directory or name of a file to be backed up changed.',
        )
      }
      const current = required(matches[0])
      if (index < entry.path.length - 1) {
        if (current.kind !== 'directory') {
          throw new ArchiveError(
            'source-changed',
            'The parent directory of a file to be backed up changed.',
          )
        }
        parentId = current.entryId
      } else if (current.entryId !== entry.entryId || current.kind !== 'file') {
        throw new ArchiveError('source-changed', 'The identity of a file to be backed up changed.')
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
        throw new ArchiveError(
          'source-changed',
          'The attributes of a file to be backed up changed.',
        )
      }
      return opened.value
    } catch (error) {
      stream.destroy()
      await finished(stream).catch(() => {})
      throw error
    }
  }
  /** 写入前保存目标目录的全部文件；没有备份轮次时返回 null，且不会写入同步目标。 */
  create(plan: SyncPlan, options: WindowsBackupOptions = {}): Promise<WindowsBackupCommit> {
    if (!isSyncPlan(plan) || !plan.canExecute || plan.target.deviceId !== this.source.deviceId) {
      throw new ArchiveError(
        'invalid-request',
        'The backup plan is invalid or the target device does not match.',
      )
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
        const targets = selectSyncBackupFiles(fixed).map((entry) =>
          targetFile(fixed, entry.entryId),
        )
        if (!targets.length) {
          return { manifest: null, cleanupError: null }
        }
        if (rounds.some((item) => !item.manifest)) {
          throw new ArchiveError('cleanup-failed', 'Clean up incomplete backup versions first.')
        }
        const files: SyncBackupFile[] = targets.map((target, index) => ({
          fileId: `f${String(index + 1).padStart(6, '0')}`,
          path: target.path,
          sizeBytes: target.sizeBytes,
          sha256: target.sha256,
          modifiedAt: target.modifiedAt,
        }))
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
          throw new ArchiveError(
            'resource-limit',
            'The backup manifest exceeds format or resource limits.',
          )
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
          const target = required(targets[index])
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
                  throw new ArchiveError('io-failure', 'The backup write made no progress.')
                }
                offset += written.bytesWritten
              }
            })
            if (value.sizeBytes !== file.sizeBytes || value.sha256 !== file.sha256) {
              throw new ArchiveError(
                'source-changed',
                'The content of a file to be backed up changed.',
              )
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
      throw new ArchiveError('checksum-mismatch', 'Backup content verification failed.')
    }
  }
  private async remove(round: BackupRound, hasMarker = true): Promise<void> {
    await this.inspectRound(round, hasMarker)
    if ([...this.handles.values()].includes(round.marker.backupId)) {
      throw new ArchiveError('busy', 'The backup is being used for a restore.')
    }
    const path = join(this.path, round.marker.backupId),
      names = await readdir(path)
    const identities = new Map<string, FileIdentity>()
    for (const name of names) {
      if (
        !['round.json', 'manifest.json', 'manifest.pending', 'manifest.retired'].includes(name) &&
        !isBatchFileId(name)
      ) {
        throw new ArchiveError(
          'cleanup-failed',
          'The backup contains unknown files. Cleanup stopped.',
        )
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
    // 所有内容先确认归属，最后才删所有权记录；失败时保留记录，这一轮可以重试。
    for (const name of [...identities.keys()].filter((name) => name !== 'round.json')) {
      await this.inspectRound(round, hasMarker)
      if (
        !hasSameIdentity(await inspectLocalPath(join(path, name)), required(identities.get(name)))
      ) {
        throw new ArchiveError('cleanup-failed', 'A backup file identity changed during cleanup.')
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
    const { keepCount } = resolveBackupPolicy(await this.readSettings(), projectId, rootId)
    if (rounds.length <= keepCount) {
      return
    }
    for (const round of rounds.slice(0, keepCount)) {
      for (const file of required(round.manifest).files) {
        await this.verifyFile(round, file, signal)
      }
    }
    for (const round of rounds.slice(keepCount)) {
      if (![...this.handles.values()].includes(round.marker.backupId)) {
        await this.remove(round)
      }
    }
  }
  /** 恢复前完整复核这一轮并取得引用，取得后才允许轮换其他轮次；目标文件此时还没有改动。 */
  acquire(
    projectId: string,
    rootId: string,
    backupId: string,
    options: WindowsBackupOptions = {},
  ): Promise<WindowsBackupHandle> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      if (this.handles.size >= 32) {
        throw new ArchiveError('resource-limit', 'Too many backup read references are open.')
      }
      const round = (await this.rounds()).find(
        (item) =>
          item.manifest &&
          item.marker.backupId === backupId &&
          item.marker.projectId === projectId &&
          item.marker.rootId === rootId,
      )
      if (!round) {
        throw new ArchiveError(
          'not-found',
          'The backup does not exist or does not belong to this project directory.',
        )
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
  /** 同包的句柄释放引用后轮换；主错误与轮换错误由调用方分别显示。 */
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
  /** 重试轮换；有引用保护或还没完成的轮次不会被删除。 */
  rotate(projectId: string, rootId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(() => this.prune(projectId, rootId))
  }
  /** 清理已确认所有权的未提交或已淘汰轮次；有效备份由 deleteBackup 删除。 */
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
        throw new ArchiveError('not-found', 'The incomplete backup does not exist.')
      }
      if (round.manifest) {
        throw new ArchiveError(
          'permission-denied',
          'Valid backups are retained through rotation and cannot be cleaned up as leftovers.',
        )
      }
      await this.remove(round)
    })
  }
  /** 用户明确删除一份已提交备份；正在用于恢复的备份由 remove 拒绝。删到一半失败时变成残留，可再清理。 */
  deleteBackup(projectId: string, rootId: string, backupId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const round = (await this.rounds()).find(
        (item) =>
          item.marker.backupId === backupId &&
          item.marker.projectId === projectId &&
          item.marker.rootId === rootId,
      )
      if (!round?.manifest) {
        throw new ArchiveError('not-found', 'The backup does not exist.')
      }
      await this.remove(round)
    })
  }
  /** 移除游戏时删除它在所有目录下的备份、残留和单独设置；中途失败时游戏保留，可以重试。 */
  deleteGameBackups(projectId: string): Promise<void> {
    if (!isOpaqueId(projectId)) {
      throw new ArchiveError('invalid-request', 'The game reference is invalid.')
    }
    return this.exclusive(async () => {
      for (const round of await this.rounds()) {
        if (round.marker.projectId === projectId) {
          await this.remove(round)
        }
      }
      await this.writeSettings(withoutGameBackups(await this.readSettings(), projectId))
    })
  }
  /** 应用退出时取消创建并关闭恢复流；备份目录和已提交轮次保留，供下次启动查询。 */
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

/** 初始化 userData/backups，要求应用私有路径已解析；已有数据只按 v1 格式读取。 */
export async function createWindowsBackupStore(
  source: BackupSource,
  privateDirectory: string,
  io: Partial<BackupDiskIO> = {},
): Promise<WindowsBackupStore> {
  if (!isAbsolute(privateDirectory) || !isOpaqueId(source.deviceId)) {
    throw new ArchiveError('invalid-request', 'Backup initialization parameters are invalid.')
  }
  await inspectLocalPath(privateDirectory)
  const path = join(privateDirectory, 'backups')
  source.assertCacheIsolated(path)
  if (stores.has(path)) {
    throw new ArchiveError('busy', 'This backup store is already open.')
  }
  stores.add(path)
  const disk = { ...BACKUP_DISK_IO, ...io }
  try {
    if (!(await exists(path))) {
      await mkdir(path, { mode: 0o700 })
    }
    const stats = await inspectLocalPath(path)
    if (!stats.isDirectory()) {
      throw new ArchiveError('invalid-request', 'The backup location is not a directory.')
    }
    if (!(await exists(join(path, 'owner.json')))) {
      if ((await readdir(path)).length) {
        throw new ArchiveError(
          'permission-denied',
          'The backup directory is nonempty and has no ownership record.',
        )
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
      throw new ArchiveError('permission-denied', 'The backup ownership record is invalid.')
    }
    source.excludePrivateDirectory(path)
    return new WindowsBackupStore(source, path, owner.storeId, getFileIdentity(stats), disk)
  } catch (error) {
    stores.delete(path)
    throw toArchiveError(error)
  }
}
