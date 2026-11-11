import type { PreparedFile } from '@savedata-sync/shared'
import { BATCH_RESOURCES } from '@savedata-sync/shared'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'

/** 生成规范化的 USTAR 头：成员名是文件 ID，权限固定为 0600，属主和时间都是 0。 */
export function createArchiveHeader(file: PreparedFile): Buffer {
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
