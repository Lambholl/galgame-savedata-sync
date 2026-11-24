import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  BACKUP_SETTINGS_SCHEMA_VERSION,
  BATCH_LIMITS,
  DEFAULT_BACKUP_SETTINGS,
  SYNC_LIMITS,
  compareSyncPaths,
  isOpaqueId,
  isSyncBackupManifest,
  readSyncBackupManifest,
  isSyncBackupSettings,
  isSyncPlan,
  isSyncSnapshot,
  selectSyncBackupFiles,
  syncPathKey,
} from '@savedata-sync/shared'
import type {
  KnownOperationError,
  SyncBackupFile,
  SyncBackupManifest,
  SyncBackupReason,
  SyncBackupSettings,
  SyncIncompleteBackup,
  SyncEntry,
  SyncPlan,
  SyncSnapshot,
} from '@savedata-sync/shared'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { FileIdentity } from './directory-paths.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import { ArchiveError, checkArchiveAbort, toArchiveError } from './archive-errors.ts'
import {
  BACKUP_DISK_IO,
  backupFolderName,
  backupRoundName,
  copyFileChecked,
  inspectBackupFile,
  openBackupFile,
  readBackupJson,
  writeBackupJson,
} from './backup-files.ts'
import type { BackupDiskIO } from './backup-files.ts'
import { BACKUP_LOCATION_FILE, readBackupLocation, saveBackupLocation } from './backup-location.ts'

type BackupSource = Pick<
  WindowsDirectoryAdapter,
  | 'deviceId'
  | 'assertCacheIsolated'
  | 'excludePrivateDirectory'
  | 'replacePrivateDirectory'
  | 'locateNativeDirectory'
>
/** 备份库的位置。 */
export interface WindowsBackupLocation {
  /** 备份库文件夹的绝对路径。 */
  readonly path: string
  /** 是否是用户选择的位置；false 表示默认位置。 */
  readonly isCustom: boolean
}
/** 磁盘上的一轮备份。isComplete 表示已提交且文件齐全；其余情况按不完整显示，可以清理但不能恢复。 */
interface BackupRound {
  readonly path: string
  readonly identity: FileIdentity
  readonly manifest: SyncBackupManifest
  readonly isComplete: boolean
}
/** 备份查询结果：已提交备份的清单和需要清理的残留备份。 */
export interface WindowsBackupListing {
  readonly backups: readonly SyncBackupManifest[]
  readonly incomplete: readonly SyncIncompleteBackup[]
}
/** 创建备份的结果。manifest 为 null 表示没有创建备份；提交后轮换旧备份失败时错误在 cleanupError，这份备份仍然有效。 */
export interface WindowsBackupCommit {
  readonly manifest: SyncBackupManifest | null
  readonly cleanupError: KnownOperationError | null
}
/** 创建备份的选项：取消信号、更短的期限和复制进度。 */
export interface WindowsBackupOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** 每写入一块后收到这次备份累计已复制的字节数；抛出的错误被忽略。 */
  readonly onProgress?: (bytesCopied: number) => void
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
function unavailable(cause: unknown): ArchiveError {
  return new ArchiveError('backup-unavailable', 'The backup library folder is unavailable.', cause)
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new ArchiveError('invalid-request', 'The backup context is incomplete.')
  }
  return value
}
function targetFile(plan: SyncPlan, entryId: string | null): SyncEntry & { sizeBytes: number } {
  const entry = required(plan.target.entries.find((item) => item.entryId === entryId))
  if (entry.kind !== 'file' || entry.sizeBytes === null) {
    throw new ArchiveError('invalid-request', 'A file to be backed up has an unknown size.')
  }
  return { ...entry, sizeBytes: entry.sizeBytes }
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
function group(projectId: string): void {
  if (!isOpaqueId(projectId)) {
    throw new ArchiveError('invalid-request', 'The backup game reference is invalid.')
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
// 备份按游戏归组，不看 rootId：游戏换了目录后，旧目录的备份照常列出、轮换和恢复。
function isInGroup(round: BackupRound, projectId: string): boolean {
  return round.manifest.projectId === projectId
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
/** 一份备份的文件夹占用的字节数；读取失败时为 null。 */
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

/** 已完整校验、用于恢复的一份备份。release 前这份备份不参加轮换；关闭全部读流后才能 release。 */
export class WindowsBackupHandle {
  private readonly store: WindowsBackupStore
  private readonly round: BackupRound
  private readonly readers = new Set<Readable>()
  private isReleased = false
  constructor(store: WindowsBackupStore, round: BackupRound) {
    this.store = store
    this.round = round
  }
  /** 备份清单的副本。 */
  get manifest(): SyncBackupManifest {
    return structuredClone(this.round.manifest)
  }
  /**
   * 按清单建立这份备份的目录树快照。
   *
   * @throws ArchiveError 已 release 时抛出，错误码为 not-found。
   */
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
  /**
   * 打开备份里的文件。流的内容没有校验，由调用方按清单核对。
   *
   * @returns 读流，由调用方关闭；verifyUnchanged 在流关闭后确认文件和这份备份都没有变化。
   */
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
  /**
   * 释放引用并轮换旧备份；重复调用直接返回 null。
   *
   * @returns 轮换失败时返回错误，否则返回 null。
   * @throws ArchiveError 还有读流没关闭时抛出，错误码为 busy。
   */
  async release(): Promise<KnownOperationError | null> {
    if (this.readers.size) {
      throw new ArchiveError('busy', 'Close backup read streams first.')
    }
    if (this.isReleased) {
      return null
    }
    this.isReleased = true
    return this.store.release(this, this.round.manifest.projectId)
  }
  /** 关闭这份备份打开的全部读流。 */
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
 * 持久备份的存储，目录结构为 备份库/游戏名/时间/，内含 backup.json 和按原路径保存的 files/。
 * 每次操作都按磁盘上的实际目录重新读取，一份备份损坏不影响其他备份；元数据操作、创建、轮换和更换位置串行执行。
 */
export class WindowsBackupStore {
  private readonly source: BackupSource
  private readonly defaultPath: string
  private readonly settingsDirectory: string
  private readonly gameName: (projectId: string) => string | null
  private readonly io: BackupDiskIO
  private queue: Promise<void> = Promise.resolve()
  private readonly handles = new Map<WindowsBackupHandle, string>()
  private active: AbortController | null = null
  private stopping: Promise<void> | null = null
  private isClosed = false
  #location: WindowsBackupLocation
  constructor(
    source: BackupSource,
    location: WindowsBackupLocation,
    defaultPath: string,
    settingsDirectory: string,
    gameName: (projectId: string) => string | null,
    io: BackupDiskIO,
  ) {
    this.source = source
    this.#location = location
    this.defaultPath = defaultPath
    this.settingsDirectory = settingsDirectory
    this.gameName = gameName
    this.io = io
  }
  /** 当前备份库文件夹的绝对路径。 */
  get path(): string {
    return this.#location.path
  }
  /** 当前备份库的位置。 */
  get location(): WindowsBackupLocation {
    return this.#location
  }
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
  /**
   * 返回备份库文件夹；默认位置不存在时重新创建。
   *
   * @throws ArchiveError 用户选择的位置不存在、不是文件夹或读不到时抛出，错误码为 backup-unavailable；
   * 备份库和已登记的根目录互相包含时错误码为 path-outside-root。
   */
  async root(): Promise<string> {
    const { path, isCustom } = this.#location
    this.source.assertCacheIsolated(path)
    if (isCustom) {
      // 用户选的文件夹不见了时不重建：盘符可能已经分给了另一块盘，备份会写到用户不知道的地方。
      let stats
      try {
        stats = await inspectLocalPath(path)
      } catch (error) {
        throw unavailable(error)
      }
      if (!stats.isDirectory()) {
        throw unavailable(null)
      }
      return path
    }
    await mkdir(path, { recursive: true })
    if (!(await inspectLocalPath(path)).isDirectory()) {
      throw new ArchiveError('invalid-request', 'The backup location is not a directory.')
    }
    return path
  }
  /** 备份库现在能否使用；默认位置不存在时重新创建。 */
  async isAvailable(): Promise<boolean> {
    try {
      await this.root()
      return true
    } catch {
      // 用不了的原因在读写备份时随错误报告，这里只给界面显示状态。
      return false
    }
  }
  /**
   * 把备份库换到 path，保存位置后生效；path 为 null 或等于默认位置时换回默认位置。
   * 已有的备份留在原来的文件夹，之后只列出新位置里的备份。
   *
   * @param path 已存在的文件夹的绝对路径。
   * @throws ArchiveError path 不是已存在的文件夹时错误码为 invalid-request；和已登记的根目录或应用的私有目录互相包含时为
   * path-outside-root；有备份正在用于恢复时为 busy；保存位置失败时为 io-failure 等文件系统错误。失败时位置不变。
   */
  relocate(path: string | null): Promise<WindowsBackupLocation> {
    if (path !== null && (typeof path !== 'string' || !isAbsolute(path))) {
      throw new ArchiveError('invalid-request', 'The backup library location is invalid.')
    }
    return this.exclusive(async () => {
      if (this.handles.size) {
        throw new ArchiveError('busy', 'A backup is being used for a restore.')
      }
      let next: WindowsBackupLocation = { path: this.defaultPath, isCustom: false }
      if (path !== null) {
        const canonical = await realpath(path).catch((error: unknown) => {
          throw new ArchiveError('invalid-request', 'The selected folder does not exist.', error)
        })
        if (!(await inspectLocalPath(canonical)).isDirectory()) {
          throw new ArchiveError('invalid-request', 'The selected entry is not a directory.')
        }
        next = { path: canonical, isCustom: canonical !== this.defaultPath }
      }
      if (!next.isCustom) {
        await mkdir(next.path, { recursive: true })
      }
      const previous = this.#location
      const undo = this.source.replacePrivateDirectory(previous.path, next.path)
      try {
        await saveBackupLocation(
          join(this.settingsDirectory, BACKUP_LOCATION_FILE),
          next.isCustom ? next.path : null,
        )
      } catch (error) {
        undo()
        throw error
      }
      stores.delete(previous.path)
      stores.add(next.path)
      this.#location = next
      return next
    })
  }
  /** 核对这份备份的文件夹没有被替换。 */
  async inspectRound(round: BackupRound): Promise<void> {
    if (!hasSameIdentity(await inspectLocalPath(round.path), round.identity)) {
      throw new ArchiveError('source-changed', 'The backup folder changed.')
    }
  }
  /** 读一个备份文件夹；不是本机备份或无法解析时返回 null。 */
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
      const manifest = readSyncBackupManifest(await readBackupJson(marker))
      if (!manifest || manifest.deviceId !== this.source.deviceId) {
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
  /** 列出这个游戏在本机所有目录下的已提交备份和残留备份。 */
  list(projectId: string): Promise<WindowsBackupListing> {
    group(projectId)
    return this.exclusive(async () => {
      const rounds = (await this.rounds()).filter((round) => isInGroup(round, projectId))
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
  /** 读取备份库设置；设置文件不存在时返回默认设置，文件损坏或不是当前格式版本时抛错。 */
  settings(): Promise<SyncBackupSettings> {
    return this.exclusive(() => this.readSettings())
  }
  private async readSettings(): Promise<SyncBackupSettings> {
    if (!(await exists(this.settingsFile))) {
      return DEFAULT_BACKUP_SETTINGS
    }
    const value: unknown = await readBackupJson(this.settingsFile)
    if (!isSyncBackupSettings(value)) {
      throw new ArchiveError('invalid-request', 'Backup settings are damaged.')
    }
    return value
  }
  /**
   * 修改备份库的保留份数；已有的备份到下一次轮换时才按新份数删除。
   *
   * @throws ArchiveError keepCount 超出 BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX 时错误码为 resource-limit。
   */
  setKeepCount(keepCount: number): Promise<SyncBackupSettings> {
    return this.exclusive(() =>
      this.writeSettings({ schemaVersion: BACKUP_SETTINGS_SCHEMA_VERSION, keepCount }),
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
  /**
   * 检查备份目录的可用空间能否放下 requiredBytes；可用空间未知时视为足够。
   *
   * @throws ArchiveError 空间不够时抛出，错误码为 insufficient-space。
   */
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
  /** 备份计划要求保护的目标文件；计划不要求备份或没有这类文件时，结果的 manifest 为 null。 */
  create(plan: SyncPlan, options: WindowsBackupOptions = {}): Promise<WindowsBackupCommit> {
    if (!isSyncPlan(plan) || !plan.canExecute || plan.target.deviceId !== this.source.deviceId) {
      throw new ArchiveError(
        'invalid-request',
        'The backup plan is invalid or the target device does not match.',
      )
    }
    const fixed = structuredClone(plan)
    const targets = fixed.shouldBackup
      ? selectSyncBackupFiles(fixed).map((entry) => targetFile(fixed, entry.entryId))
      : []
    return this.commitTargets(
      fixed.projectId,
      fixed.target.rootId,
      fixed.operation,
      targets,
      options,
    )
  }
  /** 从本机扫描快照备份全部文件；没有文件时结果的 manifest 为 null，快照无效、文件大小未知或超限时抛 ArchiveError。 */
  createManual(
    projectId: string,
    snapshot: SyncSnapshot,
    options: WindowsBackupOptions = {},
  ): Promise<WindowsBackupCommit> {
    if (
      !isOpaqueId(projectId) ||
      !isSyncSnapshot(snapshot) ||
      snapshot.deviceId !== this.source.deviceId ||
      snapshot.error !== null
    ) {
      throw new ArchiveError(
        'invalid-request',
        'The backup snapshot is invalid or does not belong to this device.',
      )
    }
    const fixed = structuredClone(snapshot)
    const targets: Array<SyncEntry & { sizeBytes: number }> = []
    let totalBytes = 0
    for (const entry of fixed.entries) {
      if (entry.kind !== 'file') {
        continue
      }
      if (entry.error !== null || entry.sizeBytes === null) {
        throw new ArchiveError('invalid-request', 'A file to be backed up has an unknown size.')
      }
      if (entry.sizeBytes > BATCH_LIMITS.maxFileBytes) {
        throw new ArchiveError('resource-limit', 'A file to be backed up exceeds the size limit.')
      }
      totalBytes += entry.sizeBytes
      targets.push({ ...entry, sizeBytes: entry.sizeBytes })
    }
    if (targets.length > BATCH_LIMITS.maxFiles || totalBytes > BATCH_LIMITS.maxTotalFileBytes) {
      throw new ArchiveError(
        'resource-limit',
        'The backup exceeds file count or total size limits.',
      )
    }
    targets.sort((left, right) => compareSyncPaths(left.path, right.path))
    return this.commitTargets(projectId, fixed.rootId, 'manual', targets, options)
  }
  private commitTargets(
    projectId: string,
    rootId: string,
    reason: SyncBackupReason,
    targets: readonly (SyncEntry & { sizeBytes: number })[],
    options: WindowsBackupOptions,
  ): Promise<WindowsBackupCommit> {
    return this.exclusive(async () => {
      const controller = new AbortController(),
        signal = operationSignal(controller, options)
      this.active = controller
      let round: BackupRound | null = null,
        hasCommitted = false
      try {
        checkArchiveAbort(signal)
        if (!targets.length) {
          return { manifest: null, cleanupError: null }
        }
        const rounds = await this.rounds()
        const files: SyncBackupFile[] = targets.map((target, index) => ({
          fileId: `f${String(index + 1).padStart(6, '0')}`,
          path: target.path,
          sizeBytes: target.sizeBytes,
          modifiedAt: target.modifiedAt,
        }))
        const manifest: SyncBackupManifest = {
          schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
          backupId: randomUUID(),
          projectId,
          deviceId: this.source.deviceId,
          rootId,
          createdAt: Math.max(Date.now(), ...rounds.map((item) => item.manifest.createdAt + 1)),
          reason,
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
        const path = await this.createRoundDirectory(projectId, manifest.createdAt)
        round = {
          path,
          identity: getFileIdentity(await inspectLocalPath(path)),
          manifest,
          isComplete: false,
        }
        await writeBackupJson(join(path, UNFINISHED), manifest, this.io)
        const root = await this.source.locateNativeDirectory(rootId)
        const directories = new Set<string>()
        let bytesCopied = 0
        for (const file of files) {
          const destination = contentPath(path, file)
          if (!directories.has(dirname(destination))) {
            await mkdir(dirname(destination), { recursive: true })
            directories.add(dirname(destination))
          }
          // 扫描后文件被改过时，备份的就不是扫描确认的内容，停止并报错。
          await copyFileChecked(
            join(root.path, ...file.path),
            destination,
            file,
            signal,
            (bytes) => {
              bytesCopied += bytes
              try {
                options.onProgress?.(bytesCopied)
              } catch {
                /* 进度观察者失败不影响备份。 */
              }
            },
          )
        }
        checkArchiveAbort(signal)
        await this.inspectRound(round)
        await rename(join(path, UNFINISHED), join(path, COMMITTED))
        hasCommitted = true
        let cleanupError: KnownOperationError | null = null
        try {
          await this.prune(projectId)
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
  /** 删除一份备份，游戏文件夹空了一起删除；中途失败时这份备份变成残留备份。 */
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
  /** 按保留份数删除多余的旧备份；只有完整的备份计入份数。 */
  private async prune(projectId: string): Promise<void> {
    const rounds = (await this.rounds())
      .filter((round) => round.isComplete && isInGroup(round, projectId))
      .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)
    const { keepCount } = await this.readSettings()
    for (const round of rounds.slice(keepCount)) {
      if (![...this.handles.values()].includes(round.manifest.backupId)) {
        await this.remove(round)
      }
    }
  }
  /** 完整复核一份备份并取得引用；引用释放前这份备份不参加轮换。 */
  acquire(
    projectId: string,
    backupId: string,
    options: WindowsBackupOptions = {},
  ): Promise<WindowsBackupHandle> {
    group(projectId)
    return this.exclusive(async () => {
      if (this.handles.size >= 32) {
        throw new ArchiveError('resource-limit', 'Too many backup read references are open.')
      }
      const round = await this.lookup(projectId, backupId)
      if (!round?.isComplete) {
        throw new ArchiveError(
          'not-found',
          'The backup does not exist or does not belong to this game.',
        )
      }
      const controller = new AbortController(),
        signal = operationSignal(controller, options)
      const handle = new WindowsBackupHandle(this, round)
      this.handles.set(handle, backupId)
      this.active = controller
      try {
        handle.snapshot()
        return handle
      } catch (error) {
        this.handles.delete(handle)
        throw toArchiveError(error, signal)
      } finally {
        this.active = null
      }
    })
  }
  private async lookup(projectId: string, backupId: string): Promise<BackupRound | undefined> {
    return (await this.rounds()).find(
      (round) => isInGroup(round, projectId) && round.manifest.backupId === backupId,
    )
  }
  /**
   * 去掉句柄的引用，再轮换这个游戏的旧备份。
   *
   * @returns 轮换失败时返回错误，否则返回 null。
   */
  async release(
    handle: WindowsBackupHandle,
    projectId: string,
  ): Promise<KnownOperationError | null> {
    this.handles.delete(handle)
    if (this.isClosed) {
      return null
    }
    try {
      await this.exclusive(() => this.prune(projectId))
      return null
    } catch (error) {
      return cleanupFailure(error)
    }
  }
  /** 按保留份数删除多余的旧备份；正在使用或不完整的备份保留。 */
  rotate(projectId: string): Promise<void> {
    group(projectId)
    return this.exclusive(() => this.prune(projectId))
  }
  /**
   * 删除一份残留备份；备份已不存在时视为成功。
   *
   * @throws ArchiveError 这份备份完整时抛出，错误码为 permission-denied。
   */
  cleanupIncomplete(projectId: string, backupId: string): Promise<void> {
    group(projectId)
    return this.exclusive(async () => {
      const round = await this.lookup(projectId, backupId)
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
  /** 删除一份备份；备份已不存在时视为成功，正在用于恢复时抛错。中途失败时这份备份变成残留备份。 */
  deleteBackup(projectId: string, backupId: string): Promise<void> {
    group(projectId)
    return this.exclusive(async () => {
      const round = await this.lookup(projectId, backupId)
      if (round) {
        await this.remove(round)
      }
    })
  }
  /** 删除一个游戏在所有目录下的备份。 */
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
    })
  }
  /** 取消正在创建的备份并关闭恢复读流，之后的操作都会失败；已提交的备份保留。 */
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
 * 初始化备份存储。settingsDirectory 里有 BACKUP_LOCATION_FILE 时用其中的位置，否则用 defaultDirectory。
 *
 * @param defaultDirectory 默认备份库的绝对路径；可以还不存在，第一次写入备份时创建。
 * @param settingsDirectory 保存备份设置和备份库位置的已有目录的绝对路径。
 * @param gameName 返回游戏的当前名称，用作新备份的文件夹名；找不到游戏时返回 null。
 * @throws ArchiveError 参数无效、默认位置的备份库和已登记的同步目录互相包含，或同一备份库已经打开时抛出。
 * @throws Error 备份库位置文件读不懂或读取失败时抛出。
 */
export async function createWindowsBackupStore(
  source: BackupSource,
  defaultDirectory: string,
  settingsDirectory: string,
  gameName: (projectId: string) => string | null,
  io: Partial<BackupDiskIO> = {},
): Promise<WindowsBackupStore> {
  if (
    !isAbsolute(defaultDirectory) ||
    !isAbsolute(settingsDirectory) ||
    !isOpaqueId(source.deviceId)
  ) {
    throw new ArchiveError('invalid-request', 'Backup initialization parameters are invalid.')
  }
  await inspectLocalPath(settingsDirectory)
  const saved = await readBackupLocation(join(settingsDirectory, BACKUP_LOCATION_FILE))
  // 用户选的位置暂时不可用时按保存的路径记下，root() 会报 backup-unavailable。
  const customPath = saved === null ? null : await realpath(saved).catch((): string => saved)
  const location: WindowsBackupLocation =
    customPath === null || customPath === defaultDirectory
      ? { path: defaultDirectory, isCustom: false }
      : { path: customPath, isCustom: true }
  if (stores.has(location.path)) {
    throw new ArchiveError('busy', 'This backup store is already open.')
  }
  if (location.isCustom) {
    try {
      source.excludePrivateDirectory(location.path)
    } catch {
      // 用户选的位置和已登记的根目录互相包含时不登记；root() 拒绝使用它，用户可以在设置里换位置。
    }
  } else {
    source.excludePrivateDirectory(location.path)
  }
  stores.add(location.path)
  return new WindowsBackupStore(source, location, defaultDirectory, settingsDirectory, gameName, {
    ...BACKUP_DISK_IO,
    ...io,
  })
}
