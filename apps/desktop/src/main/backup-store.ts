import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
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
  readSyncBackupSettings,
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
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { FileIdentity } from './directory-paths.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import { ArchiveError, checkArchiveAbort, toArchiveError } from './archive-errors.ts'
import {
  BACKUP_DISK_IO,
  backupFolderName,
  backupRoundName,
  copyFileHashed,
  inspectBackupFile,
  openBackupFile,
  readBackupJson,
  writeBackupJson,
} from './backup-files.ts'
import type { BackupDiskIO } from './backup-files.ts'

type BackupSource = Pick<
  WindowsDirectoryAdapter,
  'deviceId' | 'assertCacheIsolated' | 'excludePrivateDirectory' | 'locateNativeDirectory'
>
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
  private readonly readers = new Set<Readable>()
  private isReleased = false
  constructor(
    private readonly store: WindowsBackupStore,
    private readonly round: BackupRound,
  ) {}
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
 * 持久备份的存储，目录结构为 backups/游戏名/时间/，内含 backup.json 和按原路径保存的 files/。
 * 每次操作都按磁盘上的实际目录重新读取，一份备份损坏不影响其他备份；元数据操作、创建和轮换串行执行。
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
  /** 返回备份根目录，不存在时重新创建。 */
  async root(): Promise<string> {
    this.source.assertCacheIsolated(this.path)
    await mkdir(this.path, { recursive: true })
    if (!(await inspectLocalPath(this.path)).isDirectory()) {
      throw new ArchiveError('invalid-request', 'The backup location is not a directory.')
    }
    return this.path
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
  /** 读取备份设置；设置文件不存在时返回默认设置，旧格式转换为当前格式，文件损坏时抛错。 */
  settings(): Promise<SyncBackupSettings> {
    return this.exclusive(() => this.readSettings())
  }
  private async readSettings(): Promise<SyncBackupSettings> {
    if (!(await exists(this.settingsFile))) {
      return EMPTY_BACKUP_SETTINGS
    }
    const value = readSyncBackupSettings(await readBackupJson(this.settingsFile))
    if (!value) {
      throw new ArchiveError('invalid-request', 'Backup settings are damaged.')
    }
    return value
  }
  /** 单独设置某个游戏；policy 为 null 时改回跟随全局设置。 */
  setPreference(projectId: string, policy: SyncBackupPolicy | null): Promise<SyncBackupSettings> {
    group(projectId)
    return this.exclusive(async () =>
      this.writeSettings(withBackupPreference(await this.readSettings(), projectId, policy)),
    )
  }
  /** 修改全局设置；单独设置的游戏不受影响。 */
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
  /** 备份计划会覆盖或删除的目标文件；计划不要求备份或没有这类文件时，结果的 manifest 为 null。 */
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
        const root = await this.source.locateNativeDirectory(fixed.target.rootId)
        const directories = new Set<string>()
        let bytesCopied = 0
        for (const file of files) {
          const destination = contentPath(path, file)
          if (!directories.has(dirname(destination))) {
            await mkdir(dirname(destination), { recursive: true })
            directories.add(dirname(destination))
          }
          const value = await copyFileHashed(
            join(root.path, ...file.path),
            destination,
            file.sizeBytes,
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
          // 扫描后文件被改过时，备份的就不是计划确认的内容，写入会覆盖用户新的改动。
          if (value.sizeBytes !== file.sizeBytes || value.sha256 !== file.sha256) {
            throw new ArchiveError(
              'source-changed',
              'The content of a file to be backed up changed.',
            )
          }
        }
        checkArchiveAbort(signal)
        await this.inspectRound(round)
        await rename(join(path, UNFINISHED), join(path, COMMITTED))
        hasCommitted = true
        let cleanupError: KnownOperationError | null = null
        try {
          await this.prune(fixed.projectId)
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
    const { keepCount } = resolveBackupPolicy(await this.readSettings(), projectId)
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
  /** 删除一个游戏在所有目录下的备份和单独设置。 */
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
 * 在 privateDirectory 下初始化备份存储。
 *
 * @param privateDirectory 应用私有目录的绝对路径。
 * @param gameName 返回游戏的当前名称，用作新备份的文件夹名；找不到游戏时返回 null。
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
