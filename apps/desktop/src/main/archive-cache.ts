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

/** 本机资源可进一步收紧，不能放宽公开协议预算；也用于无大文件的边界验证。 */
export interface ArchiveQuota {
  readonly maxFileBytes: number
  readonly maxTotalFileBytes: number
  readonly maxTarBytes: number
  readonly maxArchiveBytes: number
  readonly maxCacheBytes: number
}

/** 受信任主进程的磁盘能力注入；路径始终经缓存所有权检查，不跨 IPC。 */
export interface ArchiveCacheIO {
  readonly availableBytes: (path: string) => Promise<bigint>
  readonly unlinkFile: (path: string) => Promise<void>
}

/** 工厂可收紧预算或替换磁盘检查/删除能力，不影响协议对外声明。 */
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
  if (name === 'archive.tar.gz' || name === 'job.json') return true
  const match = /^(?:raw|file)-(f\d{6})$/.exec(name)
  return match !== null && isBatchFileId(match[1])
}

async function readMarker(path: string): Promise<Record<string, unknown>> {
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 256)
    throw new ArchiveError('cleanup-failed', '缓存所有权记录无效，停止访问。')
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ArchiveError('cleanup-failed', '缓存所有权记录无法解析。', error)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ArchiveError('cleanup-failed', '缓存所有权记录无效。')
  return value as Record<string, unknown>
}

/** 单个私有任务；所有读流由调用者关闭，清理只删除确认属于本应用的普通文件。 */
export class ArchiveCacheJob {
  readonly path: string
  private readonly cache: ArchiveCache
  private readonly identity: FileIdentity
  private readonly jobId: string
  private readonly readers = new Set<ReadStream>()
  private bytes = 0
  private isBusy = true
  private isCleaned = false
  private markerWritten = false
  private cleaning: Promise<void> | null = null

  constructor(cache: ArchiveCache, path: string, jobId: string, identity: FileIdentity) {
    this.cache = cache
    this.path = path
    this.jobId = jobId
    this.identity = identity
  }

  /** 创建后先写内部所有权记录，失败仍由当前内存所有者负责安全清理。 */
  async initialize(): Promise<void> {
    const text = JSON.stringify({ ownerId: this.cache.ownerId, jobId: this.jobId })
    await this.reserve(Buffer.byteLength(text))
    await writeFile(join(this.path, 'job.json'), text, { flag: 'wx', mode: 0o600 })
    this.markerWritten = true
  }

  /** 启动时仅认领已验证的孤儿任务，不恢复旧清单或继续传输。 */
  markOrphan(): void {
    this.markerWritten = true
    this.isBusy = false
  }

  /** 操作已结束，缓存仍由返回句柄持有，直至明确清理。 */
  markIdle(): void {
    this.isBusy = false
  }

  /** 按待写字节先计数再写盘，并检查真实可用空间；失败不能越过硬限。 */
  async reserve(bytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.bytes + bytes > this.cache.quota.maxCacheBytes
    )
      throw new ArchiveError('resource-limit', '私有缓存超过资源预算。')
    const available = await this.cache.io.availableBytes(this.path)
    if (available < BigInt(bytes))
      throw new ArchiveError('insufficient-space', '私有缓存空间不足。')
    this.bytes += bytes
  }

  /** 仅创建固定内部文件名，独占打开，绝不按归档名展开路径。 */
  async writer(name: string): Promise<WriteStream> {
    await this.inspect()
    if (!isCacheName(name) || name === 'job.json')
      throw new ArchiveError('invalid-request', '私有缓存文件名无效。')
    return createWriteStream(join(this.path, name), {
      flags: 'wx',
      mode: 0o600,
      highWaterMark: BATCH_RESOURCES.maxBufferBytes,
    })
  }

  /** 打开受限只读流；未关闭的流阻止清理，调用者须消费或 destroy。 */
  async reader(
    name: string,
    range?: { readonly start: number; readonly end: number },
  ): Promise<ReadStream> {
    await this.inspect()
    if (!isCacheName(name) || name === 'job.json')
      throw new ArchiveError('invalid-request', '私有缓存引用无效。')
    const path = join(this.path, name)
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
      throw new ArchiveError('path-outside-root', '私有缓存文件身份无效。')
    if (this.isCleaned || this.cleaning)
      throw new ArchiveError('task-conflict', '缓存已经释放或正在清理。')
    const stream = createReadStream(path, {
      highWaterMark: BATCH_RESOURCES.maxBufferBytes,
      ...range,
    })
    this.readers.add(stream)
    stream.once('close', () => this.readers.delete(stream))
    return stream
  }

  /** 校验根、任务目录身份及标记；不承诺对抗外部恶意并发命名空间替换。 */
  async inspect(): Promise<void> {
    if (this.isCleaned || this.cleaning)
      throw new ArchiveError('task-conflict', '私有缓存已经释放或正在清理。')
    await this.cache.inspect()
    if (
      !isWithinDirectory(this.cache.path, this.path) ||
      !hasSameIdentity(await inspectLocalPath(this.path), this.identity)
    )
      throw new ArchiveError('path-outside-root', '任务缓存目录身份发生变化。')
    if (this.markerWritten) {
      const marker = await readMarker(join(this.path, 'job.json'))
      if (
        Object.keys(marker).length !== 2 ||
        marker.ownerId !== this.cache.ownerId ||
        marker.jobId !== this.jobId
      )
        throw new ArchiveError('cleanup-failed', '任务缓存所有权不匹配。')
    }
  }

  /** 幂等清理；失败保留标记/互斥供重试，不能静默继续创建下一任务。 */
  async dispose(): Promise<void> {
    if (this.isCleaned) return
    if (this.cleaning) return this.cleaning
    if (this.isBusy || this.readers.size > 0)
      throw new ArchiveError('busy', '请先停止归档操作并关闭缓存读流。')
    // 在第一个 await 返回前发布清理 Promise，让并发 dispose 共享同一次操作。
    this.cleaning = this.removeVerifiedFiles()
      .then(
        () => {
          this.isCleaned = true
          if (activeJob === this) activeJob = null
        },
        (error: unknown) => {
          throw new ArchiveError(
            'cleanup-failed',
            '私有缓存清理失败，保留所有权记录以便重试。',
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
    // 先完整核实，再逐个 unlink；拒绝陌生文件/子目录/链接，不递归删除任意树。
    for (const name of names) {
      const stats = await lstat(join(this.path, name))
      if (!isCacheName(name) || !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
        throw new ArchiveError('cleanup-failed', '缓存包含未确认归属的条目，停止清理。')
    }
    for (const name of names.filter((name) => name !== 'job.json'))
      await this.cache.io.unlinkFile(join(this.path, name))
    if (names.includes('job.json')) {
      await this.cache.io.unlinkFile(join(this.path, 'job.json'))
      this.markerWritten = false
    }
    await rmdir(this.path)
  }

  private async removeVerifiedFiles(): Promise<void> {
    await this.inspect()
    await this.removeOwnedFiles()
  }
}

/** 缓存根由主进程配置，不能位于源目录中；进程内只允许一个活动缓存任务。 */
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
    for (const key of Object.keys(DEFAULT_QUOTA) as (keyof ArchiveQuota)[])
      if (
        !Number.isSafeInteger(this.quota[key]) ||
        this.quota[key] <= 0 ||
        this.quota[key] > DEFAULT_QUOTA[key]
      )
        throw new ArchiveError('invalid-request', '本机归档预算只能收紧，不能放宽。')
    this.io = { ...DEFAULT_IO, ...options.io }
  }

  /** 每次访问都重查缓存根身份；实际路径不经公开 DTO 传递。 */
  async inspect(): Promise<void> {
    this.assertIsolated(this.path)
    if (!hasSameIdentity(await inspectLocalPath(this.path), this.identity))
      throw new ArchiveError('path-outside-root', '缓存根目录身份发生变化。')
  }

  /** 原子领取进程内互斥并创建随机任务目录；不是持久化传输账本。 */
  async createJob(): Promise<ArchiveCacheJob> {
    if (activeJob) throw new ArchiveError('busy', '已有归档任务或未释放的缓存。')
    await this.inspect()
    // inspect 的 await 之后再次检查，避免并发调用同时取得互斥。
    if (activeJob) throw new ArchiveError('busy', '已有归档任务或未释放的缓存。')
    const jobId = randomUUID()
    const path = join(this.path, `job-${jobId}`)
    const placeholder = new ArchiveCacheJob(this, path, jobId, { dev: '', ino: '' })
    activeJob = placeholder
    let directoryCreated = false
    try {
      await mkdir(path, { mode: 0o700 })
      directoryCreated = true
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
          throw new ArchiveError('cleanup-failed', '缓存初始化失败且无法清理。', cleanup)
        }
        throw error
      }
      return job
    } catch (error) {
      if (activeJob === placeholder) {
        if (directoryCreated)
          throw new ArchiveError('cleanup-failed', '已创建缓存但无法核实身份，停止新任务。', error)
        activeJob = null
      }
      throw error
    }
  }

  /** 调用失败遗留缓存的显式重试；正在操作/仍有读流时拒绝清理。 */
  async retryCleanup(): Promise<void> {
    if (activeJob && !isWithinDirectory(this.path, activeJob.path))
      throw new ArchiveError('busy', '另一个缓存根仍有活动任务。')
    if (activeJob) await activeJob.dispose()
  }
}

/**
 * 初始化主进程提供的既有应用私有目录中的固定缓存子目录。
 * assertIsolated 必须检查全部已登记源根；只认领带匹配所有权标记的旧任务。
 * 不删除陌生目录或恢复旧任务；初始化失败抛脱敏归档错误，原始 cause 留进程内。
 */
export async function createArchiveCache(
  privateDirectory: string,
  assertIsolated: (path: string) => void,
  options: ArchiveCacheOptions = {},
): Promise<ArchiveCache> {
  if (activeJob) throw new ArchiveError('busy', '已有归档任务尚未释放。')
  if (!isAbsolute(privateDirectory))
    throw new ArchiveError('invalid-request', '缓存位置必须为应用私有绝对目录。')
  await inspectLocalPath(privateDirectory)
  const parent = await realpath(privateDirectory)
  const path = join(parent, 'transfer-archives-v1')
  assertIsolated(path)
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error
  }
  const stats = await inspectLocalPath(path)
  if (!stats.isDirectory()) throw new ArchiveError('invalid-request', '缓存根不是目录。')
  const markerPath = join(path, 'cache-root.json')
  if (created)
    await writeFile(
      markerPath,
      JSON.stringify({ format: 'savedata-archive-cache', version: 1, ownerId: randomUUID() }),
      { flag: 'wx', mode: 0o600 },
    )
  const marker = await readMarker(markerPath)
  if (
    Object.keys(marker).length !== 3 ||
    marker.format !== 'savedata-archive-cache' ||
    marker.version !== 1 ||
    !isOpaqueId(marker.ownerId)
  )
    throw new ArchiveError('cleanup-failed', '缓存根所有权记录不匹配。')
  const cache = new ArchiveCache(
    path,
    marker.ownerId,
    getFileIdentity(stats),
    options,
    assertIsolated,
  )
  for (const name of await readdir(path)) {
    if (name === 'cache-root.json') continue
    const match = /^job-([0-9a-f-]{36})$/.exec(name)
    if (!match?.[1]) throw new ArchiveError('cleanup-failed', '缓存根存在未确认归属的条目。')
    const jobPath = join(path, name)
    const jobStats = await inspectLocalPath(jobPath)
    if (!jobStats.isDirectory()) throw new ArchiveError('cleanup-failed', '孤儿缓存类型无效。')
    const job = new ArchiveCacheJob(cache, jobPath, match[1], getFileIdentity(jobStats))
    job.markOrphan()
    await job.dispose()
  }
  return cache
}
