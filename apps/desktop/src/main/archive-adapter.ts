import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip, createInflateRaw } from 'node:zlib'
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
import { inspectLocalPath } from './directory-paths.ts'

type ArchiveSource = Pick<WindowsDirectoryAdapter, 'deviceId' | 'openFile' | 'assertCacheIsolated'>

/** 准备和校验阶段的计数；已暂存的归档字节不计入网络传输进度。 */
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

/** 归档操作的选项：signal 用于取消和超时，回调收到只读的计数快照。 */
export interface ArchiveOperationOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (counters: ArchiveCounters) => void
}

/** 接收归档的选项。检查点回调在压缩体完整落盘并核对长度和 SHA 后调用，此时 tar 和原文还没校验。 */
export interface ArchiveReceiveOptions extends ArchiveOperationOptions {
  readonly onArchiveStored?: () => void
}

/** 归档缓存的句柄。打开的读流用完要关闭；dispose 后所有方法失效。 */
export interface WindowsArchive {
  readonly manifest: BatchManifest
  readonly openArchive: () => Promise<Readable>
  readonly openFile: (fileId: string) => Promise<Readable>
  readonly dispose: () => Promise<void>
}

/** 复制内容里的一个文件：fileId 是 tar 成员名，大小和修改日期是确认时的值。 */
export interface SyncContentFile {
  readonly fileId: string
  readonly entryId: string
  readonly sizeBytes: number
  readonly modifiedAt: number | null
}

/** 收发复制内容的选项：onBytes 收到累计已打包或已解包的文件内容字节数。 */
export interface SyncContentOptions {
  readonly signal?: AbortSignal
  readonly onBytes?: (bytes: number) => void
}

/** 解包到私有缓存的复制内容。打开的读流用完要关闭；dispose 后所有方法失效。 */
export interface WindowsStagedFiles {
  readonly openFile: (fileId: string) => Promise<Readable>
  readonly dispose: () => Promise<void>
}

/** 按块计数并占用缓存配额的流，超过 maximum 字节时报 resource-limit。 */
function createLimiter(
  job: ArchiveCacheJob,
  maximum: number,
  signal: AbortSignal | undefined,
  onBytes: (chunk: Buffer) => void,
): Transform {
  let sizeBytes = 0
  return new Transform({
    highWaterMark: BATCH_RESOURCES.maxBufferBytes,
    transform(chunk: Buffer, encoding, callback) {
      void encoding
      if (!Buffer.isBuffer(chunk) || sizeBytes + chunk.length > maximum) {
        callback(
          new ArchiveError('resource-limit', 'Archive bytes exceed the local resource budget.'),
        )
        return
      }
      job
        .reserve(chunk.length)
        .then(() => {
          checkArchiveAbort(signal)
          sizeBytes += chunk.length
          onBytes(chunk)
          callback(null, chunk)
        })
        .catch((error: unknown) => callback(toArchiveError(error, signal)))
    },
  })
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
    if (!Buffer.isBuffer(chunk)) {
      throw new ArchiveError('io-failure', 'Native streams must provide binary data.')
    }
    for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
      yield chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
    }
  }
}

function createCounter(
  job: ArchiveCacheJob,
  maximum: number,
  shouldStore: boolean,
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
        callback(
          new ArchiveError('resource-limit', 'Archive bytes exceed the local resource budget.'),
        )
        return
      }
      const reserve = shouldStore ? job.reserve(chunk.length) : Promise.resolve()
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
      if (earlyError.value) {
        throw earlyError.value
      }
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
    if (actual !== file.sizeBytes || hash.digest('hex') !== file.sha256) {
      throw new ArchiveError('checksum-mismatch', 'Private source snapshot verification failed.')
    }
    const padding = (512 - (file.sizeBytes % 512)) % 512
    if (padding) {
      yield Buffer.alloc(padding)
    }
  }
  yield Buffer.alloc(1024)
}

async function readSmall(job: ArchiveCacheJob, start: number, size: number): Promise<Buffer> {
  const source = await job.reader('archive.tar.gz', { start, end: start + size - 1 })
  const parts: Buffer[] = []
  for await (const chunk of binaryChunks(source)) {
    parts.push(chunk)
  }
  const result = Buffer.concat(parts)
  if (result.length !== size) {
    throw new ArchiveError('invalid-archive', 'The fixed gzip header or trailer is truncated.')
  }
  return result
}

/** Windows 的归档编解码器：在私有缓存里生成和接收 tar.gz。 */
export class WindowsArchiveAdapter {
  private readonly source: ArchiveSource
  private readonly cache: ArchiveCache

  constructor(source: ArchiveSource, cache: ArchiveCache) {
    this.source = source
    this.cache = cache
  }

  /** 检查接收压缩体和解包后原文所需的磁盘空间。 */
  async checkReceiveSpace(
    manifest: BatchManifest,
  ): Promise<{ device: string; requiredBytes: number }> {
    if (!isBatchManifest(manifest)) {
      throw new ArchiveError('invalid-request', 'The receive manifest is invalid.')
    }
    await this.cache.inspect()
    const required = manifest.archive.sizeBytes + manifest.totalFileBytes
    if ((await this.cache.io.availableBytes(this.cache.path)) < BigInt(required)) {
      throw new ArchiveError(
        'insufficient-space',
        'Private cache space is insufficient to receive this archive batch.',
      )
    }
    return {
      device: (await inspectLocalPath(this.cache.path)).dev.toString(),
      requiredBytes: required,
    }
  }

  /** 检查私有缓存能否放下 bytes 字节的解包内容，返回缓存所在的卷和需要的字节数。 */
  async checkStagingSpace(bytes: number): Promise<{ device: string; requiredBytes: number }> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ArchiveError('invalid-request', 'The staging byte count is invalid.')
    }
    if (bytes > this.cache.quota.maxTotalFileBytes) {
      throw new ArchiveError('resource-limit', 'The content exceeds the local resource budget.')
    }
    await this.cache.inspect()
    if ((await this.cache.io.availableBytes(this.cache.path)) < BigInt(bytes)) {
      throw new ArchiveError(
        'insufficient-space',
        'Private cache space is insufficient to receive this content.',
      )
    }
    return {
      device: (await inspectLocalPath(this.cache.path)).dev.toString(),
      requiredBytes: bytes,
    }
  }

  /**
   * 按 files 的顺序读取源文件，边读边打包成 tar.gz 写进 destination，写完后结束 destination。
   *
   * @throws ArchiveError 文件的大小或修改日期与 files 不同、读取期间被改动时抛 source-changed。
   */
  async sendFiles(
    rootId: string,
    files: readonly SyncContentFile[],
    destination: Writable,
    options: SyncContentOptions = {},
  ): Promise<void> {
    checkArchiveAbort(options.signal)
    const source = this.source
    let bytes = 0
    async function* tar(): AsyncGenerator<Buffer> {
      for (const file of files) {
        checkArchiveAbort(options.signal)
        const opened = await source.openFile({ rootId, entryId: file.entryId })
        if (opened.status === 'error') {
          throw new ArchiveError(
            opened.error.code === 'result-unknown' ? 'io-failure' : opened.error.code,
            opened.error.message,
          )
        }
        const { metadata, stream, verifyUnchanged } = opened.value
        try {
          if (
            !isEntryMetadata(metadata) ||
            metadata.kind !== 'file' ||
            metadata.rootId !== rootId ||
            metadata.entryId !== file.entryId ||
            metadata.sizeBytes !== file.sizeBytes ||
            metadata.modifiedAt !== file.modifiedAt
          ) {
            throw new ArchiveError('source-changed', 'The source file differs from confirmation.')
          }
          yield createArchiveHeader(file)
          let actual = 0
          for await (const chunk of binaryChunks(stream)) {
            checkArchiveAbort(options.signal)
            actual += chunk.length
            if (actual > file.sizeBytes) {
              throw new ArchiveError('source-changed', 'The source file grew while sending.')
            }
            bytes += chunk.length
            options.onBytes?.(bytes)
            yield chunk
          }
          if (actual !== file.sizeBytes) {
            throw new ArchiveError('source-changed', 'The source file shrank while sending.')
          }
          await verifyUnchanged()
        } finally {
          stream.destroy()
        }
        const padding = (512 - (file.sizeBytes % 512)) % 512
        if (padding) {
          yield Buffer.alloc(padding)
        }
      }
      yield Buffer.alloc(1024)
    }
    await pipeline(
      Readable.from(tar(), { objectMode: false, highWaterMark: BATCH_RESOURCES.maxBufferBytes }),
      createGzip({ level: 1, chunkSize: BATCH_RESOURCES.maxBufferBytes }),
      destination,
      { signal: options.signal },
    )
  }

  /**
   * 读完 input，按 files 的顺序把 tar.gz 解包到私有缓存。失败或取消时清理本次缓存。
   *
   * @returns 解包后的文件，用完后 dispose。
   * @throws ArchiveError 成员的名称、大小或顺序与 files 不同，或 gzip 的 CRC、长度不对时抛 invalid-archive。
   */
  async receiveFiles(
    files: readonly SyncContentFile[],
    input: Readable,
    options: SyncContentOptions = {},
  ): Promise<WindowsStagedFiles> {
    const earlyError: { value: Error | null } = { value: null }
    const rememberError = (error: Error): void => {
      earlyError.value ??= error
    }
    input.on('error', rememberError)
    try {
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
      const tarBytes = files.reduce(
        (sum, file) => sum + 512 + Math.ceil(file.sizeBytes / 512) * 512,
        1024,
      )
      if (
        totalBytes > this.cache.quota.maxTotalFileBytes ||
        tarBytes > this.cache.quota.maxTarBytes ||
        files.some((file) => file.sizeBytes > this.cache.quota.maxFileBytes)
      ) {
        throw new ArchiveError('resource-limit', 'The content exceeds the local resource budget.')
      }
      await this.checkStagingSpace(totalBytes)
      return await this.run(async (job) => {
        if (earlyError.value) {
          throw earlyError.value
        }
        let bytes = 0
        await pipeline(
          input,
          createGunzip({ chunkSize: BATCH_RESOURCES.maxBufferBytes }),
          async (source: AsyncIterable<unknown>) => {
            const reader = new ArchiveReader(source, options.signal)
            for (const file of files) {
              if (!(await reader.read(512)).equals(createArchiveHeader(file))) {
                throw new ArchiveError(
                  'invalid-archive',
                  'A tar member, order, type, or normalized header is invalid.',
                )
              }
              const body = async function* (): AsyncGenerator<Buffer> {
                let remaining = file.sizeBytes
                while (remaining > 0) {
                  const chunk = await reader.read(
                    Math.min(remaining, BATCH_RESOURCES.maxBufferBytes),
                  )
                  remaining -= chunk.length
                  yield chunk
                }
              }
              await pipeline(
                Readable.from(body(), {
                  objectMode: false,
                  highWaterMark: BATCH_RESOURCES.maxBufferBytes,
                }),
                createLimiter(job, file.sizeBytes, options.signal, (chunk) => {
                  bytes += chunk.length
                  options.onBytes?.(bytes)
                }),
                await job.writer(`file-${file.fileId}`),
                { signal: options.signal },
              )
              const padding = await reader.read((512 - (file.sizeBytes % 512)) % 512)
              if (padding.some((byte) => byte !== 0)) {
                throw new ArchiveError('invalid-archive', 'Tar padding contains nonzero data.')
              }
            }
            if ((await reader.read(1024)).some((byte) => byte !== 0)) {
              throw new ArchiveError(
                'invalid-archive',
                'The tar archive is missing two standard end blocks.',
              )
            }
            await reader.expectEnd()
          },
          { signal: options.signal },
        )
        return Object.freeze({
          openFile: async (fileId: string): Promise<Readable> => {
            if (!files.some((file) => file.fileId === fileId)) {
              throw new ArchiveError('invalid-request', 'The file does not belong to this content.')
            }
            try {
              return await job.reader(`file-${fileId}`)
            } catch (error) {
              throw toArchiveError(error)
            }
          },
          dispose: () => job.dispose(),
        })
      }, options)
    } finally {
      input.destroy()
      input.off('error', rememberError)
    }
  }

  /**
   * 读取源文件，生成快照和 gzip 归档。失败或取消时清理本次缓存。
   *
   * @returns 归档句柄，用完后 dispose。
   */
  async prepare(request: unknown, options: ArchiveOperationOptions = {}): Promise<WindowsArchive> {
    if (!isDownloadBatchRequest(request)) {
      throw new ArchiveError('invalid-request', 'The batch download request is invalid.')
    }
    return this.run(async (job, counters) => {
      const files = await this.snapshot(request, job, counters, options)
      const tarSizeBytes = files.reduce(
        (sum, file) => sum + 512 + Math.ceil(file.sizeBytes / 512) * 512,
        1024,
      )
      if (tarSizeBytes > this.cache.quota.maxTarBytes) {
        throw new ArchiveError(
          'resource-limit',
          'Uncompressed tar data exceeds the resource budget.',
        )
      }
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
      if (!isBatchManifest(manifest)) {
        throw new ArchiveError(
          'invalid-request',
          'The generated batch manifest exceeds protocol limits.',
        )
      }
      return this.artifact(job, freezeManifest(manifest), 'raw')
    }, options)
  }

  /** 接管输入流，完整暂存并校验压缩体后解包。 */
  async receive(
    manifest: unknown,
    input: Readable,
    options: ArchiveReceiveOptions = {},
  ): Promise<WindowsArchive> {
    const earlyError: { value: Error | null } = { value: null }
    const rememberError = (error: Error): void => {
      earlyError.value ??= error
    }
    input.on('error', rememberError)
    try {
      if (!isBatchManifest(manifest)) {
        throw new ArchiveError('invalid-request', 'The receive manifest is invalid.')
      }
      const snapshot = freezeManifest(manifest)
      await this.checkReceiveSpace(snapshot)
      if (
        snapshot.totalFileBytes > this.cache.quota.maxTotalFileBytes ||
        snapshot.archive.sizeBytes > this.cache.quota.maxArchiveBytes ||
        snapshot.archive.tarSizeBytes > this.cache.quota.maxTarBytes ||
        snapshot.files.some((file) => file.sizeBytes > this.cache.quota.maxFileBytes)
      ) {
        throw new ArchiveError(
          'resource-limit',
          'The receive manifest exceeds the local resource budget.',
        )
      }
      return await this.run(async (job, counters) => {
        if (earlyError.value) {
          throw earlyError.value
        }
        const counter = createCounter(
          job,
          this.cache.quota.maxArchiveBytes,
          true,
          options,
          (chunk) => {
            counters.archiveBytesStored += chunk.length
            if (counters.archiveBytesStored > snapshot.archive.sizeBytes) {
              throw new ArchiveError(
                'checksum-mismatch',
                'Compressed content exceeds the manifest length.',
              )
            }
            options.onProgress?.({ ...counters })
          },
        )
        await copyIntoJob(input, job, 'archive.tar.gz', counter.stream, options.signal)
        const actual = counter.result()
        if (
          actual.sizeBytes !== snapshot.archive.sizeBytes ||
          actual.sha256 !== snapshot.archive.sha256
        ) {
          throw new ArchiveError(
            'checksum-mismatch',
            'The compressed content length or hash does not match the manifest.',
          )
        }
        checkArchiveAbort(options.signal)
        options.onArchiveStored?.()
        await this.unpack(job, snapshot, counters, options)
        return this.artifact(job, snapshot, 'file')
      }, options)
    } finally {
      input.destroy()
      input.off('error', rememberError)
    }
  }

  /** 重试本缓存根中失败的清理；正在使用的文件保留。 */
  async retryCleanup(): Promise<void> {
    await this.cache.retryCleanup()
  }

  private async run<T>(
    operation: (job: ArchiveCacheJob, counters: MutableArchiveCounters) => Promise<T>,
    options: { readonly signal?: AbortSignal },
  ): Promise<T> {
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
            message: 'Private cache cleanup failed. Retry cleanup.',
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
      if (result.status === 'error') {
        throw new ArchiveError(
          result.error.code === 'result-unknown' ? 'io-failure' : result.error.code,
          result.error.message,
        )
      }
      const source = result.value
      const metadata = source.metadata
      try {
        if (
          !isEntryMetadata(metadata) ||
          metadata.kind !== 'file' ||
          metadata.rootId !== request.sourceRootId ||
          metadata.entryId !== selection.entryId
        ) {
          throw new ArchiveError('invalid-request', 'Source file metadata does not match.')
        }
        const counter = createCounter(
          job,
          this.cache.quota.maxFileBytes,
          true,
          options,
          (chunk) => {
            counters.sourceBytesRead += chunk.length
            if (counters.sourceBytesRead > this.cache.quota.maxTotalFileBytes) {
              throw new ArchiveError(
                'resource-limit',
                'Total uncompressed data exceeds the resource budget.',
              )
            }
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
        if (metadata.sizeBytes !== null && actual.sizeBytes !== metadata.sizeBytes) {
          throw new ArchiveError('source-changed', 'The source file length changed while reading.')
        }
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
    if (size < 20) {
      throw new ArchiveError('invalid-archive', 'The gzip content is too short.')
    }
    const header = await readSmall(job, 0, 10)
    const trailer = await readSmall(job, size - 8, 8)
    if (!header.subarray(0, 8).equals(Buffer.from([31, 139, 8, 0, 0, 0, 0, 0]))) {
      throw new ArchiveError(
        'invalid-archive',
        'The gzip header does not match the restricted single-member format.',
      )
    }
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
          if (!(await reader.read(512)).equals(createArchiveHeader(file))) {
            throw new ArchiveError(
              'invalid-archive',
              'A tar member, order, type, or normalized header is invalid.',
            )
          }
          const counter = createCounter(
            job,
            this.cache.quota.maxFileBytes,
            true,
            options,
            (chunk) => {
              counters.verifiedFileBytes += chunk.length
              if (counters.verifiedFileBytes > this.cache.quota.maxTotalFileBytes) {
                throw new ArchiveError(
                  'resource-limit',
                  'Extracted data exceeds the resource budget.',
                )
              }
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
          if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256) {
            throw new ArchiveError(
              'checksum-mismatch',
              'The extracted file content does not match the manifest.',
            )
          }
          const padding = await reader.read((512 - (file.sizeBytes % 512)) % 512)
          if (padding.some((byte) => byte !== 0)) {
            throw new ArchiveError('invalid-archive', 'Tar padding contains nonzero data.')
          }
          counters.verifiedFiles++
          options.onProgress?.({ ...counters })
        }
        if ((await reader.read(1024)).some((byte) => byte !== 0)) {
          throw new ArchiveError(
            'invalid-archive',
            'The tar archive is missing two standard end blocks.',
          )
        }
        await reader.expectEnd()
      },
      { signal: options.signal },
    )
    const tar = tarCounter.result()
    if (inflater.bytesWritten !== size - 18 || tar.sizeBytes !== manifest.archive.tarSizeBytes) {
      throw new ArchiveError(
        'invalid-archive',
        'The gzip archive contains concatenated members, trailing content, or ambiguous lengths.',
      )
    }
    if (trailer.readUInt32LE(0) !== crc.value || trailer.readUInt32LE(4) !== tar.sizeBytes) {
      throw new ArchiveError('invalid-archive', 'Gzip CRC32 or ISIZE verification failed.')
    }
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
        if (!manifest.files.some((file) => file.fileId === fileId)) {
          return Promise.reject(
            new ArchiveError(
              'invalid-request',
              'The cached file does not belong to this manifest.',
            ),
          )
        }
        return open(`${prefix}-${fileId}`)
      },
      dispose: () => job.dispose(),
    })
  }
}

/** 在已有的应用私有目录里创建归档编解码器，并清理带本应用标记的遗留缓存任务。 */
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
