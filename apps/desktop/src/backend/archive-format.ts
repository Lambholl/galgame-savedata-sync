import { Transform } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import type { InflateRaw } from 'node:zlib'
import { BATCH_RESOURCES } from '@savedata-sync/shared'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'

/** 生成规范化的 USTAR 头：成员名是文件 ID，权限固定为 0600，属主和时间都是 0。 */
export function createArchiveHeader(file: {
  readonly fileId: string
  readonly sizeBytes: number
}): Buffer {
  const header = Buffer.alloc(512)
  header.write(file.fileId, 0, 'ascii')
  const octal = (offset: number, width: number, value: number): void => {
    header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii')
  }
  octal(100, 8, 0o600)
  octal(108, 8, 0)
  octal(116, 8, 0)
  octal(124, 12, file.sizeBytes)
  octal(136, 12, 0)
  header.fill(32, 148, 156)
  header[156] = 48
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  octal(329, 8, 0)
  octal(337, 8, 0)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

const CRC_TABLE: number[] = []
for (let value = 0; value < 256; value++) {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  CRC_TABLE.push(crc >>> 0)
}

/** 流式计算 gzip 使用的 CRC32。 */
export class ArchiveCrc32 {
  private state = 0xffffffff

  /** 累加一段数据。 */
  update(chunk: Buffer): void {
    for (const byte of chunk) {
      this.state = (this.state >>> 8) ^ (CRC_TABLE[(this.state ^ byte) & 255] ?? 0)
    }
  }

  /** 已累加数据的 CRC32。 */
  get value(): number {
    return (this.state ^ 0xffffffff) >>> 0
  }
}

// gzip 固定头的前 8 字节：魔数、CM=8、FLG=0、MTIME=0。XFL 和 OS 随压缩库变化，不比较。
const GZIP_HEADER_PREFIX = Buffer.from([31, 139, 8, 0, 0, 0, 0, 0])
const GZIP_HEADER_BYTES = 10
const GZIP_TRAILER_BYTES = 8

/**
 * 只接受单成员、无可选头字段的 gzip 解压器。按 frame、inflater、check 的顺序接入管道，
 * 管道结束后调用 verify。头部不符或内容截断时管道报 invalid-archive。
 */
export interface StrictGunzip {
  readonly frame: Transform
  readonly inflater: InflateRaw
  readonly check: Transform
  /**
   * 核对 gzip 尾部。
   *
   * @throws ArchiveError DEFLATE 数据后面还有内容，或者 CRC32、ISIZE 和解压结果不符时抛 invalid-archive。
   */
  verify(): void
}

/** 创建一个 StrictGunzip。 */
export function createStrictGunzip(): StrictGunzip {
  let header = Buffer.alloc(0)
  let trailer = Buffer.alloc(0)
  let bodyBytes = 0
  let outputBytes = 0
  const crc = new ArchiveCrc32()
  const frame = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let data = chunk
      if (header.length < GZIP_HEADER_BYTES) {
        const needed = GZIP_HEADER_BYTES - header.length
        header = Buffer.concat([header, data.subarray(0, needed)])
        data = data.subarray(needed)
        if (
          header.length === GZIP_HEADER_BYTES &&
          !header.subarray(0, GZIP_HEADER_PREFIX.length).equals(GZIP_HEADER_PREFIX)
        ) {
          callback(new ArchiveError('invalid-archive', 'The gzip header is not supported.'))
          return
        }
      }
      // 输入结束前认不出哪 8 字节是尾部，所以始终扣住最后 GZIP_TRAILER_BYTES 字节不交给解压器。
      const joined = Buffer.concat([trailer, data])
      const kept = Math.min(GZIP_TRAILER_BYTES, joined.length)
      trailer = joined.subarray(joined.length - kept)
      const body = joined.subarray(0, joined.length - kept)
      bodyBytes += body.length
      callback(null, body.length > 0 ? body : undefined)
    },
    flush(callback) {
      callback(
        trailer.length < GZIP_TRAILER_BYTES
          ? new ArchiveError('invalid-archive', 'The gzip content is truncated.')
          : null,
      )
    },
  })
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      crc.update(chunk)
      outputBytes += chunk.length
      callback(null, chunk)
    },
  })
  const inflater = createInflateRaw({ chunkSize: BATCH_RESOURCES.maxBufferBytes })
  return {
    frame,
    inflater,
    check,
    verify() {
      // 解压器读到 DEFLATE 结束块就停，后面拼接的成员或多余字节不计入 bytesWritten。
      if (inflater.bytesWritten !== bodyBytes) {
        throw new ArchiveError('invalid-archive', 'The gzip content has trailing data.')
      }
      if (
        trailer.readUInt32LE(0) !== crc.value ||
        trailer.readUInt32LE(4) !== outputBytes % 2 ** 32
      ) {
        throw new ArchiveError('invalid-archive', 'Gzip CRC32 or ISIZE verification failed.')
      }
    },
  }
}

/** 按字节数顺序读取 tar 流。 */
export class ArchiveReader {
  private readonly iterator: AsyncIterator<unknown>
  private chunk: Buffer = Buffer.alloc(0)
  private offset = 0
  private readonly signal: AbortSignal | undefined

  constructor(source: AsyncIterable<unknown>, signal?: AbortSignal) {
    this.iterator = source[Symbol.asyncIterator]()
    this.signal = signal
  }

  /**
   * 读取恰好 size 字节，size 不超过 BATCH_RESOURCES.maxBufferBytes。
   *
   * @throws ArchiveError 流提前结束、含非二进制数据或 size 无效时抛出。
   */
  async read(size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > BATCH_RESOURCES.maxBufferBytes) {
      throw new ArchiveError('invalid-request', 'The archive read buffer size is invalid.')
    }
    const result = Buffer.alloc(size)
    let written = 0
    while (written < size) {
      checkArchiveAbort(this.signal)
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done) {
          throw new ArchiveError('invalid-archive', 'A tar member or end block is truncated.')
        }
        if (!Buffer.isBuffer(next.value)) {
          throw new ArchiveError('invalid-archive', 'The archive stream must contain binary bytes.')
        }
        this.chunk = next.value
        this.offset = 0
        if (this.chunk.length === 0) {
          continue
        }
      }
      const count = Math.min(size - written, this.chunk.length - this.offset)
      this.chunk.copy(result, written, this.offset, this.offset + count)
      this.offset += count
      written += count
    }
    return result
  }

  /**
   * 读完流并确认没有剩余数据。
   *
   * @throws ArchiveError 流里还有数据时抛出。
   */
  async expectEnd(): Promise<void> {
    if (this.offset !== this.chunk.length) {
      throw new ArchiveError('invalid-archive', 'Extra content follows the end of the tar archive.')
    }
    for (;;) {
      checkArchiveAbort(this.signal)
      const next = await this.iterator.next()
      if (next.done) {
        return
      }
      if (!Buffer.isBuffer(next.value) || next.value.length !== 0) {
        throw new ArchiveError(
          'invalid-archive',
          'Extra content follows the end of the tar archive.',
        )
      }
    }
  }
}
