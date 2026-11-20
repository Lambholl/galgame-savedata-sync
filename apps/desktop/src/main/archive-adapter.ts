import { Readable, Transform } from 'node:stream'
import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { BATCH_RESOURCES, isEntryMetadata } from '@savedata-sync/shared'
import { createArchiveCache } from './archive-cache.ts'
import type { ArchiveCache, ArchiveCacheJob, ArchiveCacheOptions } from './archive-cache.ts'
import { ArchiveError, checkArchiveAbort, toArchiveError } from './archive-errors.ts'
import { ArchiveReader, createArchiveHeader, createStrictGunzip } from './archive-format.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { inspectLocalPath } from './directory-paths.ts'

type ArchiveSource = Pick<WindowsDirectoryAdapter, 'openFile' | 'assertCacheIsolated'>

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

/** Windows 的归档编解码器：边读源文件边打包发送 tar.gz，接收时解包到私有缓存。 */
export class WindowsArchiveAdapter {
  private readonly source: ArchiveSource
  private readonly cache: ArchiveCache

  constructor(source: ArchiveSource, cache: ArchiveCache) {
    this.source = source
    this.cache = cache
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
        const gunzip = createStrictGunzip()
        await pipeline(
          input,
          gunzip.frame,
          gunzip.inflater,
          gunzip.check,
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
        gunzip.verify()
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

  /** 重试本缓存根中失败的清理；正在使用的文件保留。 */
  async retryCleanup(): Promise<void> {
    await this.cache.retryCleanup()
  }

  private async run<T>(
    operation: (job: ArchiveCacheJob) => Promise<T>,
    options: { readonly signal?: AbortSignal },
  ): Promise<T> {
    checkArchiveAbort(options.signal)
    let job: ArchiveCacheJob | undefined
    try {
      job = await this.cache.createJob()
      const artifact = await operation(job)
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
