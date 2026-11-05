import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  BATCH_LIMITS,
  EMPTY_BACKUP_SETTINGS,
  SYNC_LIMITS,
  compareSyncPaths,
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
  backupFolderName,
  backupRoundName,
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
/** 磁盘上的一轮备份。isComplete 表示已提交且文件齐全；其余情况按不完整显示，可以清理但不能恢复。 */
interface BackupRound {
  readonly path: string
  readonly identity: FileIdentity
  readonly manifest: SyncBackupManifest
  readonly isComplete: boolean
}
/** 备份查询结果：当前项目的清单和需要显式清理的轮次，不含文件路径。 */
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
const COMMITTED = 'backup.json'
const UNFINISHED = 'in-progress.json'
const CONTENT = 'files'
const MAX_DIRECTORY_ENTRIES = 4096
const MAX_SAME_SECOND_ROUNDS = 100

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
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}
async function exists(path: string): Promise<boolean> {
  try {
    await inspectLocalPath(path)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}
function isInGroup(round: BackupRound, projectId: string, rootId: string): boolean {
  return round.manifest.projectId === projectId && round.manifest.rootId === rootId
}
function contentPath(roundPath: string, file: SyncBackupFile): string {
  return join(roundPath, CONTENT, ...file.path)
}
async function listDirectory(path: string): Promise<Dirent[]> {
  const entries = await readdir(path, { withFileTypes: true })
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new ArchiveError('resource-limit', 'The number of backups exceeds the limit.')
  }
  return entries
}
/** 检查备份是否完好：只核对文件在不在、大小对不对，内容在恢复前完整校验。 */
async function isIntact(roundPath: string, manifest: SyncBackupManifest): Promise<boolean> {
  for (const file of manifest.files) {
    try {
      const stats = await lstat(contentPath(roundPath, file), { bigint: true })
      if (!stats.isFile() || stats.nlink !== 1n || stats.size !== BigInt(file.sizeBytes)) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}
/** 一轮文件夹占用的字节数；读取失败时未知，由界面单独显示。 */
async function occupiedBytes(round: BackupRound): Promise<number | null> {
  try {
    let total = 0
    const entries = await readdir(round.path, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        total += (await lstat(join(entry.parentPath, entry.name))).size
      }
    }
    return total
  } catch {
    return null
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
    return structuredClone(this.round.manifest)
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
    const file = this.round.manifest.files.find((item) => item.fileId === fileId)
    if (!file) {
      throw new ArchiveError('not-found', 'The backup file reference does not exist.')
    }
    await this.store.inspectRound(this.round)
    const value = await openBackupFile(contentPath(this.round.path, file), file.sizeBytes)
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
    return this.store.release(this, this.round.manifest.projectId, this.round.manifest.rootId)
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
 * 持久备份，放在用户能直接管理的文件夹：backups/游戏名/时间/，内含 backup.json 和按原路径保存的 files/，和移动端相同。
 * 用户可以随时删除或改名其中任何内容，所以每次都按实际目录重新读取，一份备份出问题不影响其他备份。
 * 元数据操作、创建和轮换串行执行，恢复材料通过引用保护；设置放在备份区外，删掉备份文件夹不丢设置。
 * 只读同步根；用法及错误和清理语义见桌面 README，通过工厂函数初始化。
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
    private readonly settingsDirectory: string,
    private readonly gameName: (projectId: string) => string | null,
    private readonly io: BackupDiskIO,
  ) {}
  private get settingsFile(): string {
    return join(this.settingsDirectory, 'backup-settings.json')
  }
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
  /** 备份根目录；不存在就重新建立，所以用户可以把整个文件夹删掉。 */
  async root(): Promise<string> {
    this.source.assertCacheIsolated(this.path)
    await mkdir(this.path, { recursive: true })
    if (!(await inspectLocalPath(this.path)).isDirectory()) {
      throw new ArchiveError('invalid-request', 'The backup location is not a directory.')
    }
    return this.path
  }
  /** 读取前核对这一轮的文件夹还是同一个；同包的恢复句柄每次读取前都调用。 */
  async inspectRound(round: BackupRound): Promise<void> {
    if (!hasSameIdentity(await inspectLocalPath(round.path), round.identity)) {
      throw new ArchiveError('source-changed', 'The backup folder changed.')
    }
  }
  /** 读一个备份文件夹；不是本机备份或读不懂的返回 null，留给用户自己处理。 */
  private async read(path: string): Promise<BackupRound | null> {
    try {
      const stats = await inspectLocalPath(path)
      if (!stats.isDirectory()) {
        return null
      }
      const isCommitted = await exists(join(path, COMMITTED))
      const marker = join(path, isCommitted ? COMMITTED : UNFINISHED)
      if (!(await exists(marker))) {
        return null
      }
      const manifest = await readBackupJson(marker)
      if (!isSyncBackupManifest(manifest) || manifest.deviceId !== this.source.deviceId) {
        return null
      }
      return {
        path,
        identity: getFileIdentity(stats),
        manifest,
        isComplete: isCommitted && (await isIntact(path, manifest)),
      }
    } catch {
      return null
    }
  }
  private async rounds(): Promise<BackupRound[]> {
    const root = await this.root()
    const result: BackupRound[] = []
    const seen = new Set<string>()
    for (const game of await listDirectory(root)) {
      if (!game.isDirectory()) {
        continue
      }
      let names: Dirent[]
      try {
        names = await listDirectory(join(root, game.name))
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          continue
        }
        throw error
      }
      for (const name of names) {
        const round = await this.read(join(root, game.name, name.name))
        if (round && !seen.has(round.manifest.backupId)) {
          seen.add(round.manifest.backupId)
          result.push(round)
        }
      }
    }
    return result
  }
  /** 列出已提交的备份清单；恢复前 acquire 会重新核对每个文件。 */
  list(projectId: string, rootId: string): Promise<WindowsBackupListing> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const rounds = (await this.rounds()).filter((round) => isInGroup(round, projectId, rootId))
      const incomplete: SyncIncompleteBackup[] = []
      for (const round of rounds) {
        if (!round.isComplete) {
          incomplete.push({
            backupId: round.manifest.backupId,
            occupiedBytes: await occupiedBytes(round),
          })
        }
      }
      return {
        backups: rounds
          .filter((round) => round.isComplete)
          .map((round) => round.manifest)
          .sort((a, b) => b.createdAt - a.createdAt),
        incomplete,
      }
    })
  }
  /** 读取备份设置。缺少文件时用默认全局设置；坏设置不会被默认值覆盖。 */
  settings(): Promise<SyncBackupSettings> {
    return this.exclusive(() => this.readSettings())
  }
  private async readSettings(): Promise<SyncBackupSettings> {
    if (!(await exists(this.settingsFile))) {
      return EMPTY_BACKUP_SETTINGS
    }
    const value = await readBackupJson(this.settingsFile)
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
    const temporary = join(this.settingsDirectory, `backup-settings-${randomUUID()}.tmp`)
    try {
      await writeBackupJson(temporary, settings, this.io)
      await rename(temporary, this.settingsFile)
    } catch (error) {
      const failure = toArchiveError(error)
      try {
        if (await exists(temporary)) {
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
    const available = await this.io.availableBytes(await this.root())
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
  /** 新备份的文件夹：游戏名/时间；同一秒已有同名文件夹时加序号。 */
  private async createRoundDirectory(projectId: string, createdAt: number): Promise<string> {
    const game = join(await this.root(), backupFolderName(this.gameName(projectId), projectId))
    await mkdir(game, { recursive: true })
    const name = backupRoundName(createdAt)
    for (let index = 1; index <= MAX_SAME_SECOND_ROUNDS; index++) {
      const path = join(game, index === 1 ? name : `${name}_${index}`)
      try {
        await mkdir(path)
        return path
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          throw error
        }
      }
    }
    throw new ArchiveError('io-failure', 'The backup folder could not be created.')
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
        hasCommitted = false
      try {
        checkArchiveAbort(signal)
        if (!fixed.shouldBackup) {
          return { manifest: null, cleanupError: null }
        }
        const targets = selectSyncBackupFiles(fixed).map((entry) =>
          targetFile(fixed, entry.entryId),
        )
        if (!targets.length) {
          return { manifest: null, cleanupError: null }
        }
        const rounds = await this.rounds()
        const files: SyncBackupFile[] = targets.map((target, index) => ({
          fileId: `f${String(index + 1).padStart(6, '0')}`,
          path: target.path,
          sizeBytes: target.sizeBytes,
          sha256: target.sha256,
          modifiedAt: target.modifiedAt,
        }))
        const manifest: SyncBackupManifest = {
          schemaVersion: 1,
          backupId: randomUUID(),
          projectId: fixed.projectId,
          deviceId: this.source.deviceId,
          rootId: fixed.target.rootId,
          createdAt: Math.max(Date.now(), ...rounds.map((item) => item.manifest.createdAt + 1)),
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
        checkArchiveAbort(signal)
        const path = await this.createRoundDirectory(fixed.projectId, manifest.createdAt)
        round = {
          path,
          identity: getFileIdentity(await inspectLocalPath(path)),
          manifest,
          isComplete: false,
        }
        await writeBackupJson(join(path, UNFINISHED), manifest, this.io)
        for (const [index, file] of files.entries()) {
          const target = required(targets[index])
          await this.inspectRound(round)
          checkArchiveAbort(signal)
          const destination = contentPath(path, file)
          await mkdir(dirname(destination), { recursive: true })
          const source = await this.sourceFile(fixed, target, signal),
            input = source.stream
          let output: FileHandle | undefined
          try {
            const handle = await open(destination, 'wx', 0o600)
            output = handle
            const value = await hashBackupStream(input, file.sizeBytes, signal, async (chunk) => {
              for (let offset = 0; offset < chunk.length;) {
                checkArchiveAbort(signal)
                const written = await handle.write(chunk, offset, chunk.length - offset)
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
        await rename(join(path, UNFINISHED), join(path, COMMITTED))
        hasCommitted = true
        let cleanupError: KnownOperationError | null = null
        try {
          await this.prune(fixed.projectId, fixed.target.rootId)
        } catch (error) {
          cleanupError = cleanupFailure(error)
        }
        return { manifest, cleanupError }
      } catch (error) {
        const failure = toArchiveError(error, signal)
        if (round && !hasCommitted) {
          try {
            await this.remove(round)
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
    const input = await openBackupFile(contentPath(round.path, file), BATCH_LIMITS.maxFileBytes)
    const value = await hashBackupStream(input.stream, file.sizeBytes, signal)
    await input.verify()
    if (value.sizeBytes !== file.sizeBytes || value.sha256 !== file.sha256) {
      throw new ArchiveError('checksum-mismatch', 'Backup content verification failed.')
    }
  }
  /** 先把备份改回未完成状态再删文件，中途失败时它显示为可清理；标记最后删，游戏文件夹空了也一起删。 */
  private async remove(round: BackupRound): Promise<void> {
    if ([...this.handles.values()].includes(round.manifest.backupId)) {
      throw new ArchiveError('busy', 'The backup is being used for a restore.')
    }
    await this.inspectRound(round)
    const marker = join(round.path, UNFINISHED)
    if (await exists(join(round.path, COMMITTED))) {
      await rename(join(round.path, COMMITTED), marker)
    }
    for (const name of await readdir(round.path)) {
      if (name !== UNFINISHED) {
        await rm(join(round.path, name), { recursive: true, force: true })
      }
    }
    await rm(marker, { force: true })
    await rmdir(round.path)
    await rmdir(dirname(round.path)).catch(() => {
      /* 游戏文件夹里还有其他备份。 */
    })
  }
  /** 按保留份数删除多余的旧备份；只统计完整的备份，用户删掉或弄坏的不计入保留份数，不会因此多删。 */
  private async prune(projectId: string, rootId: string): Promise<void> {
    const rounds = (await this.rounds())
      .filter((round) => round.isComplete && isInGroup(round, projectId, rootId))
      .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)
    const { keepCount } = resolveBackupPolicy(await this.readSettings(), projectId, rootId)
    for (const round of rounds.slice(keepCount)) {
      if (![...this.handles.values()].includes(round.manifest.backupId)) {
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
      const round = await this.lookup(projectId, rootId, backupId)
      if (!round?.isComplete) {
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
        for (const file of round.manifest.files) {
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
  private async lookup(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<BackupRound | undefined> {
    return (await this.rounds()).find(
      (round) => isInGroup(round, projectId, rootId) && round.manifest.backupId === backupId,
    )
  }
  /** 同包的句柄释放引用后轮换；主错误与轮换错误由调用方分别显示。 */
  async release(
    handle: WindowsBackupHandle,
    projectId: string,
    rootId: string,
  ): Promise<KnownOperationError | null> {
    this.handles.delete(handle)
    if (this.isClosed) {
      return null
    }
    try {
      await this.exclusive(() => this.prune(projectId, rootId))
      return null
    } catch (error) {
      return cleanupFailure(error)
    }
  }
  /** 重试轮换；有引用保护或不完整的轮次不会被删除。 */
  rotate(projectId: string, rootId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(() => this.prune(projectId, rootId))
  }
  /** 清理未完成或文件已缺失的备份；已经不存在就算清理完成。有效备份由 deleteBackup 删除。 */
  cleanupIncomplete(projectId: string, rootId: string, backupId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const round = await this.lookup(projectId, rootId, backupId)
      if (!round) {
        return
      }
      if (round.isComplete) {
        throw new ArchiveError(
          'permission-denied',
          'Valid backups are retained through rotation and cannot be cleaned up as leftovers.',
        )
      }
      await this.remove(round)
    })
  }
  /** 用户在应用里删除一份备份；正在用于恢复的由 remove 拒绝，已被手动删除的算删除成功。删到一半失败时变成不完整，可再清理。 */
  deleteBackup(projectId: string, rootId: string, backupId: string): Promise<void> {
    group(projectId, rootId)
    return this.exclusive(async () => {
      const round = await this.lookup(projectId, rootId, backupId)
      if (round) {
        await this.remove(round)
      }
    })
  }
  /** 移除游戏时删除它在所有目录下的备份和单独设置；中途失败时游戏保留，可以重试。 */
  deleteGameBackups(projectId: string): Promise<void> {
    if (!isOpaqueId(projectId)) {
      throw new ArchiveError('invalid-request', 'The game reference is invalid.')
    }
    return this.exclusive(async () => {
      for (const round of await this.rounds()) {
        if (round.manifest.projectId === projectId) {
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

/**
 * 初始化 userData/backups，要求应用私有路径已解析。
 * gameName 返回游戏当前名称，只决定新备份的文件夹名；找不到时返回 null。
 */
export async function createWindowsBackupStore(
  source: BackupSource,
  privateDirectory: string,
  gameName: (projectId: string) => string | null,
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
  source.excludePrivateDirectory(path)
  return new WindowsBackupStore(source, path, privateDirectory, gameName, {
    ...BACKUP_DISK_IO,
    ...io,
  })
}
