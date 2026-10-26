import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createInflateRaw } from 'node:zlib'
import {
  BATCH_ARCHIVE,
  BATCH_RESOURCES,
  isBatchManifest,
  isDownloadBatchRequest,
  isEntryMetadata,
} from '@savedata-sync/shared'
import type { BatchManifest, DownloadBatchRequest, PreparedFile } from '@savedata-sync/shared'
import { createArchiveCache } from './archive-cache.ts'
import type { ArchiveCache, ArchiveCacheJob, ArchiveCacheOptions } from './archive-cache.ts'
import { ArchiveError, checkArchiveAbort, toArchiveError } from './archive-errors.ts'
import { ArchiveCrc32, ArchiveReader, createArchiveHeader } from './archive-format.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'

type ArchiveSource = Pick<WindowsDirectoryAdapter, 'deviceId' | 'openFile' | 'assertCacheIsolated'>

/** 原生准备/校验阶段的本次计数，不将已暂存归档字节冒充网络传输进度。 */
export interface ArchiveCounters {
  readonly sourceBytesRead: number
  readonly archiveBytesStored: number
  readonly verifiedFileBytes: number
  readonly verifiedFiles: number
}

interface MutableArchiveCounters {
  sourceBytesRead: number
  archiveBytesStored: number
  verifiedFileBytes: number
  verifiedFiles: number
}

/** signal 由调用者管理期限；回调只传只读数值快照，不包含文件内容。 */
export interface ArchiveOperationOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (counters: ArchiveCounters) => void
}

/** 只供主进程持有的缓存句柄；读流须关闭，dispose 后全部方法失效，不经 IPC 传递。 */
export interface WindowsArchive {
  readonly manifest: BatchManifest
  readonly openArchive: () => Promise<Readable>
  readonly openFile: (fileId: string) => Promise<Readable>
  readonly dispose: () => Promise<void>
}

function freezeManifest(manifest: BatchManifest): BatchManifest {
  return Object.freeze({
    ...manifest,
    files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
    archive: Object.freeze({ ...manifest.archive }),
  })
}

async function* binaryChunks(source: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    if (!Buffer.isBuffer(chunk)) throw new ArchiveError('io-failure', '原生流必须提供二进制数据。')
    for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes)
      yield chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
  }
}

function createCounter(
  job: ArchiveCacheJob,
  maximum: number,
  store: boolean,
  options: ArchiveOperationOptions,
  onBytes: (chunk: Buffer) => void,
): { stream: Transform; result: () => { sizeBytes: number; sha256: string } } {
  let sizeBytes = 0
  const hash = createHash('sha256')
  const stream = new Transform({
    highWaterMark: BATCH_RESOURCES.maxBufferBytes,
    transform(chunk: Buffer, encoding, callback) {
      void encoding
      if (!Buffer.isBuffer(chunk) || sizeBytes + chunk.length > maximum) {
        callback(new ArchiveError('resource-limit', '归档字节数超过本机资源预算。'))
        return
      }
      const reserve = store ? job.reserve(chunk.length) : Promise.resolve()
      reserve
        .then(() => {
          checkArchiveAbort(options.signal)
          sizeBytes += chunk.length
          hash.update(chunk)
          onBytes(chunk)
          callback(null, chunk)
        })
        .catch((error: unknown) => callback(toArchiveError(error, options.signal)))
    },
  })
  return { stream, result: () => ({ sizeBytes, sha256: hash.digest('hex') }) }
}

async function copyIntoJob(
  input: Readable,
  job: ArchiveCacheJob,
  name: string,
  counter: Transform,
  signal?: AbortSignal,
): Promise<void> {
  const earlyError: { value: Error | null } = { value: null }
  const rememberError = (error: Error): void => {
    earlyError.value = error
  }
  const cancel = (): void => {
    input.destroy()
  }
  input.on('error', rememberError)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    checkArchiveAbort(signal)
    const writer = await job.writer(name)
    if (earlyError.value || signal?.aborted) {
      writer.destroy()
      if (earlyError.value) throw earlyError.value
      checkArchiveAbort(signal)
    }
    const bounded = Readable.from(binaryChunks(input), {
      objectMode: false,
      highWaterMark: BATCH_RESOURCES.maxBufferBytes,
    })
    await pipeline(bounded, counter, writer, { signal })
  } finally {
    signal?.removeEventListener('abort', cancel)
    input.destroy()
    input.off('error', rememberError)
  }
}

async function* tarChunks(
  job: ArchiveCacheJob,
  files: readonly PreparedFile[],
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  for (const file of files) {
    checkArchiveAbort(signal)
    yield createArchiveHeader(file)
    const source = await job.reader(`raw-${file.fileId}`)
    const hash = createHash('sha256')
    let actual = 0
    try {
      for await (const chunk of binaryChunks(source)) {
        checkArchiveAbort(signal)
        actual += chunk.length
        hash.update(chunk)
        yield chunk
      }
    } finally {
      source.destroy()
    }
    if (actual !== file.sizeBytes || hash.digest('hex') !== file.sha256)
      throw new ArchiveError('checksum-mismatch', '私有源快照校验失败。')
    const padding = (512 - (file.sizeBytes % 512)) % 512
    if (padding) yield Buffer.alloc(padding)
  }
  yield Buffer.alloc(1024)
}

async function readSmall(job: ArchiveCacheJob, start: number, size: number): Promise<Buffer> {
  const source = await job.reader('archive.tar.gz', { start, end: start + size - 1 })
  const parts: Buffer[] = []
  for await (const chunk of binaryChunks(source)) parts.push(chunk)
  const result = Buffer.concat(parts)
  if (result.length !== size) throw new ArchiveError('invalid-archive', 'gzip 固定头或尾部被截断。')
  return result
}

/** Windows 私有归档编解码，不提供 HTTP、目标发布或任何 Renderer 方法。 */
export class WindowsArchiveAdapter {
  private readonly source: ArchiveSource
  private readonly cache: ArchiveCache

  constructor(source: ArchiveSource, cache: ArchiveCache) {
    this.source = source
    this.cache = cache
  }

  /** 生成独立源快照与 gzip1 归档；失败/取消清理本次缓存，成功将释放责任交给句柄。 */
  async prepare(request: unknown, options: ArchiveOperationOptions = {}): Promise<WindowsArchive> {
    if (!isDownloadBatchRequest(request))
      throw new ArchiveError('invalid-request', '批量下载请求无效。')
    return this.run(async (job, counters) => {
      const files = await this.snapshot(request, job, counters, options)
      const tarSizeBytes = files.reduce(
        (sum, file) => sum + 512 + Math.ceil(file.sizeBytes / 512) * 512,
        1024,
      )
      if (tarSizeBytes > this.cache.quota.maxTarBytes)
        throw new ArchiveError('resource-limit', 'tar 原文超过资源预算。')
      const counter = createCounter(
        job,
        this.cache.quota.maxArchiveBytes,
        true,
        options,
        (chunk) => {
          counters.archiveBytesStored += chunk.length
          options.onProgress?.({ ...counters })
        },
      )
      const input = Readable.from(tarChunks(job, files, options.signal), {
        objectMode: false,
        highWaterMark: BATCH_RESOURCES.maxBufferBytes,
      })
      await pipeline(
        input,
        createGzip({
          level: 1,
          chunkSize: BATCH_RESOURCES.maxBufferBytes,
        }),
        counter.stream,
        await job.writer('archive.tar.gz'),
        { signal: options.signal },
      )
      const archive = counter.result()
      const manifest: BatchManifest = {
        protocolVersion: 1,
        transferId: request.transferId,
        sourceDeviceId: this.source.deviceId,
        sourceRootId: request.sourceRootId,
        files,
        totalFileBytes: counters.sourceBytesRead,
        archive: { format: BATCH_ARCHIVE.format, compressionLevel: 1, ...archive, tarSizeBytes },
      }
      if (!isBatchManifest(manifest))
        throw new ArchiveError('invalid-request', '生成的批量清单超出协议范围。')
      return this.artifact(job, freezeManifest(manifest), 'raw')
    }, options)
  }

  /** 接管原始输入流，先完整暂存并校验压缩体，再解包到私有文件；不发布目标。 */
  async receive(
    manifest: unknown,
    input: Readable,
    options: ArchiveOperationOptions = {},
  ): Promise<WindowsArchive> {
    const earlyError: { value: Error | null } = { value: null }
    const rememberError = (error: Error): void => {
      earlyError.value ??= error
    }
    input.on('error', rememberError)
    try {
      if (!isBatchManifest(manifest)) throw new ArchiveError('invalid-request', '接收清单无效。')
      const snapshot = freezeManifest(manifest)
      if (
        snapshot.totalFileBytes > this.cache.quota.maxTotalFileBytes ||
        snapshot.archive.sizeBytes > this.cache.quota.maxArchiveBytes ||
        snapshot.archive.tarSizeBytes > this.cache.quota.maxTarBytes ||
        snapshot.files.some((file) => file.sizeBytes > this.cache.quota.maxFileBytes)
      )
        throw new ArchiveError('resource-limit', '接收清单超过本机资源预算。')
      return await this.run(async (job, counters) => {
        if (earlyError.value) throw earlyError.value
        const counter = createCounter(
          job,
          this.cache.quota.maxArchiveBytes,
          true,
          options,
          (chunk) => {
            counters.archiveBytesStored += chunk.length
            if (counters.archiveBytesStored > snapshot.archive.sizeBytes)
              throw new ArchiveError('checksum-mismatch', '压缩体长度超过清单。')
            options.onProgress?.({ ...counters })
          },
        )
        await copyIntoJob(input, job, 'archive.tar.gz', counter.stream, options.signal)
        const actual = counter.result()
        if (
          actual.sizeBytes !== snapshot.archive.sizeBytes ||
          actual.sha256 !== snapshot.archive.sha256
        )
          throw new ArchiveError('checksum-mismatch', '压缩体长度或哈希与清单不符。')
        await this.unpack(job, snapshot, counters, options)
        return this.artifact(job, snapshot, 'file')
      }, options)
    } finally {
      input.destroy()
      input.off('error', rememberError)
    }
  }

  /** 明确重试本缓存根的失败清理；不删除其他缓存根或正在使用的文件。 */
  async retryCleanup(): Promise<void> {
    await this.cache.retryCleanup()
  }

  private async run(
    operation: (job: ArchiveCacheJob, counters: MutableArchiveCounters) => Promise<WindowsArchive>,
    options: ArchiveOperationOptions,
  ): Promise<WindowsArchive> {
    checkArchiveAbort(options.signal)
    let job: ArchiveCacheJob | undefined
    try {
      job = await this.cache.createJob()
      const artifact = await operation(job, {
        sourceBytesRead: 0,
        archiveBytesStored: 0,
        verifiedFileBytes: 0,
        verifiedFiles: 0,
      })
      checkArchiveAbort(options.signal)
      job.markIdle()
      return artifact
    } catch (error) {
      const failure = toArchiveError(error, options.signal)
      if (job) {
        job.markIdle()
        try {
          await job.dispose()
        } catch (cleanup) {
          failure.cleanupError = {
            code: 'cleanup-failed',
            message: '私有缓存清理失败，请重试清理。',
            canRetry: false,
          }
          failure.cause = { operation: failure.cause, cleanup }
        }
      }
      throw failure
    }
  }

  private async snapshot(
    request: DownloadBatchRequest,
    job: ArchiveCacheJob,
    counters: MutableArchiveCounters,
    options: ArchiveOperationOptions,
  ): Promise<PreparedFile[]> {
    const files: PreparedFile[] = []
    for (const selection of request.files) {
      checkArchiveAbort(options.signal)
      const result = await this.source.openFile({
        rootId: request.sourceRootId,
        entryId: selection.entryId,
      })
      if (result.status === 'error')
        throw new ArchiveError(
          result.error.code === 'result-unknown' ? 'io-failure' : result.error.code,
          result.error.message,
        )
      const source = result.value
      const metadata = source.metadata
      try {
        if (
          !isEntryMetadata(metadata) ||
          metadata.kind !== 'file' ||
          metadata.rootId !== request.sourceRootId ||
          metadata.entryId !== selection.entryId
        )
          throw new ArchiveError('invalid-request', '源文件元数据不匹配。')
        const counter = createCounter(
          job,
          this.cache.quota.maxFileBytes,
          true,
          options,
          (chunk) => {
            counters.sourceBytesRead += chunk.length
            if (counters.sourceBytesRead > this.cache.quota.maxTotalFileBytes)
              throw new ArchiveError('resource-limit', '原文总量超过资源预算。')
            options.onProgress?.({
              sourceBytesRead: counters.sourceBytesRead,
              archiveBytesStored: 0,
              verifiedFileBytes: 0,
              verifiedFiles: 0,
            })
          },
        )
        await copyIntoJob(
          source.stream,
          job,
          `raw-${selection.fileId}`,
          counter.stream,
          options.signal,
        )
        await source.verifyUnchanged()
        const actual = counter.result()
        if (metadata.sizeBytes !== null && actual.sizeBytes !== metadata.sizeBytes)
          throw new ArchiveError('source-changed', '源文件长度在读取期间变化。')
        files.push({
          fileId: selection.fileId,
          sourceEntryId: metadata.entryId,
          sourceParentId: metadata.parentId,
          sourceName: metadata.name,
          sourceModifiedAt: metadata.modifiedAt,
          ...actual,
        })
      } finally {
        source.stream.destroy()
      }
    }
    return files
  }

  private async unpack(
    job: ArchiveCacheJob,
    manifest: BatchManifest,
    counters: MutableArchiveCounters,
    options: ArchiveOperationOptions,
  ): Promise<void> {
    const size = manifest.archive.sizeBytes
    if (size < 20) throw new ArchiveError('invalid-archive', 'gzip 内容过短。')
    const header = await readSmall(job, 0, 10)
    const trailer = await readSmall(job, size - 8, 8)
    if (!header.subarray(0, 8).equals(Buffer.from([31, 139, 8, 0, 0, 0, 0, 0])))
      throw new ArchiveError('invalid-archive', 'gzip 头不符合单成员受限格式。')
    const crc = new ArchiveCrc32()
    const tarCounter = createCounter(job, this.cache.quota.maxTarBytes, false, options, (chunk) =>
      crc.update(chunk),
    )
    const inflater = createInflateRaw({
      chunkSize: BATCH_RESOURCES.maxBufferBytes,
    })
    const input = await job.reader('archive.tar.gz', { start: 10, end: size - 9 })
    await pipeline(
      input,
      inflater,
      tarCounter.stream,
      async (source: AsyncIterable<unknown>) => {
        const reader = new ArchiveReader(source, options.signal)
        for (const file of manifest.files) {
          if (!(await reader.read(512)).equals(createArchiveHeader(file)))
            throw new ArchiveError('invalid-archive', 'tar 成员、顺序、类型或规范化头无效。')
          const counter = createCounter(
            job,
            this.cache.quota.maxFileBytes,
            true,
            options,
            (chunk) => {
              counters.verifiedFileBytes += chunk.length
              if (counters.verifiedFileBytes > this.cache.quota.maxTotalFileBytes)
                throw new ArchiveError('resource-limit', '解包原文超过资源预算。')
              options.onProgress?.({ ...counters })
            },
          )
          const body = async function* (): AsyncGenerator<Buffer> {
            let remaining = file.sizeBytes
            while (remaining > 0) {
              const chunk = await reader.read(Math.min(remaining, BATCH_RESOURCES.maxBufferBytes))
              remaining -= chunk.length
              yield chunk
            }
          }
          await pipeline(
            Readable.from(body(), {
              objectMode: false,
              highWaterMark: BATCH_RESOURCES.maxBufferBytes,
            }),
            counter.stream,
            await job.writer(`file-${file.fileId}`),
            { signal: options.signal },
          )
          const actual = counter.result()
          if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256)
            throw new ArchiveError('checksum-mismatch', '解包文件内容与清单不符。')
          const padding = await reader.read((512 - (file.sizeBytes % 512)) % 512)
          if (padding.some((byte) => byte !== 0))
            throw new ArchiveError('invalid-archive', 'tar 填充包含非零数据。')
          counters.verifiedFiles++
          options.onProgress?.({ ...counters })
        }
        if ((await reader.read(1024)).some((byte) => byte !== 0))
          throw new ArchiveError('invalid-archive', 'tar 缺少两个规范结束块。')
        await reader.expectEnd()
      },
      { signal: options.signal },
    )
    const tar = tarCounter.result()
    if (inflater.bytesWritten !== size - 18 || tar.sizeBytes !== manifest.archive.tarSizeBytes)
      throw new ArchiveError('invalid-archive', 'gzip 包含拼接成员、尾随内容或长度歧义。')
    if (trailer.readUInt32LE(0) !== crc.value || trailer.readUInt32LE(4) !== tar.sizeBytes)
      throw new ArchiveError('invalid-archive', 'gzip CRC32 或 ISIZE 校验失败。')
  }

  private artifact(
    job: ArchiveCacheJob,
    manifest: BatchManifest,
    prefix: 'raw' | 'file',
  ): WindowsArchive {
    const open = async (name: string): Promise<Readable> => {
      try {
        return await job.reader(name)
      } catch (error) {
        throw toArchiveError(error)
      }
    }
    return Object.freeze({
      manifest,
      openArchive: () => open('archive.tar.gz'),
      openFile: (fileId: string) => {
        if (!manifest.files.some((file) => file.fileId === fileId))
          return Promise.reject(new ArchiveError('invalid-request', '缓存文件不属于本次清单。'))
        return open(`${prefix}-${fileId}`)
      },
      dispose: () => job.dispose(),
    })
  }
}

/** 在既有应用私有目录建立隔离缓存；初始化清理仅处理匹配标记的孤儿任务。 */
export async function createWindowsArchiveAdapter(
  source: ArchiveSource,
  privateDirectory: string,
  options: ArchiveCacheOptions = {},
): Promise<WindowsArchiveAdapter> {
  try {
    return new WindowsArchiveAdapter(
      source,
      await createArchiveCache(
        privateDirectory,
        (path) => source.assertCacheIsolated(path),
        options,
      ),
    )
  } catch (error) {
    throw toArchiveError(error)
  }
}
