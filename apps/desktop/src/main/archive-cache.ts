import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import type { ReadStream, WriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { BATCH_LIMITS, BATCH_RESOURCES, isBatchFileId, isOpaqueId } from '@savedata-sync/shared'
import { ArchiveError } from './archive-errors.ts'
import {
  getFileIdentity,
  hasSameIdentity,
  inspectLocalPath,
  isWithinDirectory,
} from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'

/** 归档缓存的字节限额，取值不大于协议公开的上限。 */
export interface ArchiveQuota {
  readonly maxFileBytes: number
  readonly maxTotalFileBytes: number
  readonly maxTarBytes: number
  readonly maxArchiveBytes: number
  readonly maxCacheBytes: number
}

/** 归档缓存用到的磁盘操作；传入的路径都已通过缓存所有权检查。 */
export interface ArchiveCacheIO {
  readonly availableBytes: (path: string) => Promise<bigint>
  readonly unlinkFile: (path: string) => Promise<void>
}

/** 缓存工厂的选项：收紧限额或替换磁盘操作。 */
export interface ArchiveCacheOptions {
  readonly quota?: Partial<ArchiveQuota>
  readonly io?: Partial<ArchiveCacheIO>
}

const DEFAULT_QUOTA: ArchiveQuota = {
  maxFileBytes: BATCH_LIMITS.maxFileBytes,
  maxTotalFileBytes: BATCH_LIMITS.maxTotalFileBytes,
  maxTarBytes: BATCH_LIMITS.maxTarBytes,
  maxArchiveBytes: BATCH_LIMITS.maxArchiveBytes,
  maxCacheBytes: BATCH_RESOURCES.maxCacheBytes,
}
const DEFAULT_IO: ArchiveCacheIO = {
  availableBytes: async (path) => {
    const stats = await statfs(path, { bigint: true })
    return stats.bavail * stats.bsize
  },
  unlinkFile: unlink,
}
let activeJob: ArchiveCacheJob | null = null

function isCacheName(name: string): boolean {
  if (name === 'archive.tar.gz' || name === 'job.json') {
    return true
  }
  const match = /^(?:raw|file)-(f\d{6})$/.exec(name)
  return match !== null && isBatchFileId(match[1])
}

async function readMarker(path: string): Promise<Record<string, unknown>> {
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 256) {
    throw new ArchiveError(
      'cleanup-failed',
      'The cache ownership record is invalid. Access stopped.',
    )
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ArchiveError('cleanup-failed', 'The cache ownership record cannot be parsed.', error)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArchiveError('cleanup-failed', 'The cache ownership record is invalid.')
  }
  return value as Record<string, unknown>
}

/** 一个私有缓存任务。读流由调用方关闭；清理时删除确认属于本应用的普通文件。 */
export class ArchiveCacheJob {
  readonly path: string
  private readonly cache: ArchiveCache
  private readonly identity: FileIdentity
  private readonly jobId: string
  private readonly readers = new Set<ReadStream>()
  private bytes = 0
  private isBusy = true
  private isCleaned = false
  private isMarkerWritten = false
  private cleaning: Promise<void> | null = null

  constructor(cache: ArchiveCache, path: string, jobId: string, identity: FileIdentity) {
    this.cache = cache
    this.path = path
    this.jobId = jobId
    this.identity = identity
  }

  /** 写入所有权记录；失败时抛错，任务需要 dispose。 */
  async initialize(): Promise<void> {
    const text = JSON.stringify({ ownerId: this.cache.ownerId, jobId: this.jobId })
    await this.reserve(Buffer.byteLength(text))
    await writeFile(join(this.path, 'job.json'), text, { flag: 'wx', mode: 0o600 })
    this.isMarkerWritten = true
  }

  /** 把任务标记为上次运行遗留的任务。 */
  markOrphan(): void {
    this.isMarkerWritten = true
    this.isBusy = false
  }

  /** 标记操作已结束；缓存保留到 dispose。 */
  markIdle(): void {
    this.isBusy = false
  }

  /** 按待写字节数计入限额并检查可用空间；超出限额或空间不足时抛错。 */
  async reserve(bytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > this.cache.quota.maxCacheBytes
    ) {
      throw new ArchiveError('resource-limit', 'The private cache exceeds the resource budget.')
    }
    const available = await this.cache.io.availableBytes(this.path)
    if (available < BigInt(bytes)) {
      throw new ArchiveError('insufficient-space', 'Private cache space is insufficient.')
    }
    this.bytes += bytes
  }

  /** 以独占方式创建写流；name 是内部固定文件名。 */
  async writer(name: string): Promise<WriteStream> {
    await this.inspect()
    if (!isCacheName(name) || name === 'job.json') {
      throw new ArchiveError('invalid-request', 'The private cache file name is invalid.')
    }
    return createWriteStream(join(this.path, name), {
      flags: 'wx',
      mode: 0o600,
      highWaterMark: BATCH_RESOURCES.maxBufferBytes,
    })
  }

  /** 打开受限只读流；流关闭前 dispose 会失败，读完或 destroy 后才能清理。 */
  async reader(
    name: string,
    range?: { readonly start: number; readonly end: number },
  ): Promise<ReadStream> {
    await this.inspect()
    if (!isCacheName(name) || name === 'job.json') {
      throw new ArchiveError('invalid-request', 'The private cache reference is invalid.')
    }
    const path = join(this.path, name)
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new ArchiveError('path-outside-root', 'The private cache file identity is invalid.')
    }
    if (this.isCleaned || this.cleaning) {
      throw new ArchiveError('task-conflict', 'The cache has been released or is being cleaned up.')
    }
    const stream = createReadStream(path, {
      highWaterMark: BATCH_RESOURCES.maxBufferBytes,
      ...range,
    })
    this.readers.add(stream)
    stream.once('close', () => this.readers.delete(stream))
    return stream
  }

  /** 校验缓存根、任务目录的身份和标记；结果只反映校验那一刻的状态。 */
  async inspect(): Promise<void> {
    if (this.isCleaned || this.cleaning) {
      throw new ArchiveError(
        'task-conflict',
        'The private cache has been released or is being cleaned up.',
      )
    }
    await this.cache.inspect()
    if (
      !isWithinDirectory(this.cache.path, this.path) ||
      !hasSameIdentity(await inspectLocalPath(this.path), this.identity)
    ) {
      throw new ArchiveError('path-outside-root', 'The task cache directory identity changed.')
    }
    if (this.isMarkerWritten) {
      const marker = await readMarker(join(this.path, 'job.json'))
      if (
        Object.keys(marker).length !== 2 ||
        marker.ownerId !== this.cache.ownerId ||
        marker.jobId !== this.jobId
      ) {
        throw new ArchiveError('cleanup-failed', 'The task cache ownership does not match.')
      }
    }
  }

  /** 清理任务缓存，可重复调用。失败时保留标记和互斥，可以重试；清理成功前不能创建新任务。 */
  async dispose(): Promise<void> {
    if (this.isCleaned) {
      return
    }
    if (this.cleaning) {
      return this.cleaning
    }
    if (this.isBusy || this.readers.size > 0) {
      throw new ArchiveError(
        'busy',
        'Stop the archive operation and close cache read streams first.',
      )
    }
    // 在第一个 await 返回前发布清理 Promise，让并发 dispose 共享同一次操作。
    this.cleaning = this.removeVerifiedFiles()
      .then(
        () => {
          this.isCleaned = true
          if (activeJob === this) {
            activeJob = null
          }
        },
        (error: unknown) => {
          throw new ArchiveError(
            'cleanup-failed',
            'Private cache cleanup failed. The ownership record is retained for retry.',
            error,
          )
        },
      )
      .finally(() => {
        this.cleaning = null
      })
    return this.cleaning
  }

  private async removeOwnedFiles(): Promise<void> {
    const names = await readdir(this.path)
    // 先核实全部条目再逐个 unlink；遇到陌生文件、子目录或链接就拒绝，避免删掉不属于缓存的目录树。
    for (const name of names) {
      const stats = await lstat(join(this.path, name))
      if (!isCacheName(name) || !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new ArchiveError(
          'cleanup-failed',
          'The cache contains entries with unconfirmed ownership. Cleanup stopped.',
        )
      }
    }
    for (const name of names.filter((name) => name !== 'job.json')) {
      await this.cache.io.unlinkFile(join(this.path, name))
    }
    if (names.includes('job.json')) {
      await this.cache.io.unlinkFile(join(this.path, 'job.json'))
      this.isMarkerWritten = false
    }
    await rmdir(this.path)
  }

  private async removeVerifiedFiles(): Promise<void> {
    await this.inspect()
    await this.removeOwnedFiles()
  }
}

/** 归档缓存的管理器；同一进程同时只有一个活动的缓存任务。 */
export class ArchiveCache {
  readonly path: string
  readonly ownerId: string
  readonly quota: ArchiveQuota
  readonly io: ArchiveCacheIO
  private readonly identity: FileIdentity
  private readonly assertIsolated: (path: string) => void

  constructor(
    path: string,
    ownerId: string,
    identity: FileIdentity,
    options: ArchiveCacheOptions,
    assertIsolated: (path: string) => void,
  ) {
    this.path = path
    this.ownerId = ownerId
    this.identity = identity
    this.assertIsolated = assertIsolated
    this.quota = Object.freeze({ ...DEFAULT_QUOTA, ...options.quota })
    for (const key of Object.keys(DEFAULT_QUOTA) as (keyof ArchiveQuota)[]) {
      if (
        !Number.isSafeInteger(this.quota[key]) ||
        this.quota[key] <= 0 ||
        this.quota[key] > DEFAULT_QUOTA[key]
      ) {
        throw new ArchiveError(
          'invalid-request',
          'The local archive budget can only be tightened, not relaxed.',
        )
      }
    }
    this.io = { ...DEFAULT_IO, ...options.io }
  }

  /** 重新核对缓存根的身份。 */
  async inspect(): Promise<void> {
    this.assertIsolated(this.path)
    if (!hasSameIdentity(await inspectLocalPath(this.path), this.identity)) {
      throw new ArchiveError('path-outside-root', 'The cache root directory identity changed.')
    }
  }

  /** 原子领取进程内互斥并创建随机任务目录。 */
  async createJob(): Promise<ArchiveCacheJob> {
    if (activeJob) {
      throw new ArchiveError('busy', 'An archive task or unreleased cache already exists.')
    }
    await this.inspect()
    // inspect 的 await 之后再次检查，避免并发调用同时取得互斥。
    if (activeJob) {
      throw new ArchiveError('busy', 'An archive task or unreleased cache already exists.')
    }
    const jobId = randomUUID()
    const path = join(this.path, `job-${jobId}`)
    const placeholder = new ArchiveCacheJob(this, path, jobId, { dev: '', ino: '' })
    activeJob = placeholder
    let wasDirectoryCreated = false
    try {
      await mkdir(path, { mode: 0o700 })
      wasDirectoryCreated = true
      const job = new ArchiveCacheJob(
        this,
        path,
        jobId,
        getFileIdentity(await lstat(path, { bigint: true })),
      )
      activeJob = job
      try {
        await job.initialize()
      } catch (error) {
        job.markIdle()
        try {
          await job.dispose()
        } catch (cleanup) {
          throw new ArchiveError(
            'cleanup-failed',
            'Cache initialization failed and cleanup was unsuccessful.',
            cleanup,
          )
        }
        throw error
      }
      return job
    } catch (error) {
      if (activeJob === placeholder) {
        if (wasDirectoryCreated) {
          throw new ArchiveError(
            'cleanup-failed',
            'The cache was created but its identity could not be verified. New tasks stopped.',
            error,
          )
        }
        activeJob = null
      }
      throw error
    }
  }

  /** 重试之前失败的缓存清理；有操作进行中或读流未关闭时拒绝。 */
  async retryCleanup(): Promise<void> {
    if (activeJob && !isWithinDirectory(this.path, activeJob.path)) {
      throw new ArchiveError('busy', 'Another cache root still has an active task.')
    }
    if (activeJob) {
      await activeJob.dispose()
    }
  }
}

/**
 * 在应用私有目录下初始化缓存子目录，并清理带本应用所有权标记的遗留任务；其他目录原样保留。
 *
 * @param assertIsolated 缓存根位于任何已登记的源根内时抛错。
 * @throws ArchiveError 初始化失败时抛出；message 已脱敏，原始错误在 cause。
 */
export async function createArchiveCache(
  privateDirectory: string,
  assertIsolated: (path: string) => void,
  options: ArchiveCacheOptions = {},
): Promise<ArchiveCache> {
  if (activeJob) {
    throw new ArchiveError('busy', 'An archive task has not yet been released.')
  }
  if (!isAbsolute(privateDirectory)) {
    throw new ArchiveError(
      'invalid-request',
      'The cache location must be an absolute path in app-private storage.',
    )
  }
  await inspectLocalPath(privateDirectory)
  const parent = await realpath(privateDirectory)
  const path = join(parent, 'transfer-archives-v1')
  assertIsolated(path)
  let wasCreated = false
  try {
    await mkdir(path, { mode: 0o700 })
    wasCreated = true
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }
  }
  const stats = await inspectLocalPath(path)
  if (!stats.isDirectory()) {
    throw new ArchiveError('invalid-request', 'The cache root is not a directory.')
  }
  const markerPath = join(path, 'cache-root.json')
  if (wasCreated) {
    await writeFile(
      markerPath,
      JSON.stringify({ format: 'savedata-archive-cache', version: 1, ownerId: randomUUID() }),
      { flag: 'wx', mode: 0o600 },
    )
  }
  const marker = await readMarker(markerPath)
  if (
    Object.keys(marker).length !== 3 ||
    marker.format !== 'savedata-archive-cache' ||
    marker.version !== 1 ||
    !isOpaqueId(marker.ownerId)
  ) {
    throw new ArchiveError('cleanup-failed', 'The cache root ownership record does not match.')
  }
  const cache = new ArchiveCache(
    path,
    marker.ownerId,
    getFileIdentity(stats),
    options,
    assertIsolated,
  )
  for (const name of await readdir(path)) {
    if (name === 'cache-root.json') {
      continue
    }
    const match = /^job-([0-9a-f-]{36})$/.exec(name)
    if (!match?.[1]) {
      throw new ArchiveError(
        'cleanup-failed',
        'The cache root contains entries with unconfirmed ownership.',
      )
    }
    const jobPath = join(path, name)
    const jobStats = await inspectLocalPath(jobPath)
    if (!jobStats.isDirectory()) {
      throw new ArchiveError('cleanup-failed', 'An orphaned cache has an invalid type.')
    }
    const job = new ArchiveCacheJob(cache, jobPath, match[1], getFileIdentity(jobStats))
    job.markOrphan()
    await job.dispose()
  }
  return cache
}
