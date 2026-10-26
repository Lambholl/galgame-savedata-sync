import type { PreparedFile } from '@savedata-sync/shared'
import { BATCH_RESOURCES } from '@savedata-sync/shared'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'

/** 生成规范化 USTAR 头；无属主、真实名称、路径、时间或扩展字段。 */
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

/** gzip CRC32 流式累积；不能代替清单的 SHA-256。 */
export class ArchiveCrc32 {
  private state = 0xffffffff

  update(chunk: Buffer): void {
    for (const byte of chunk) {
      this.state = (this.state >>> 8) ^ (CRC_TABLE[(this.state ^ byte) & 255] ?? 0)
    }
  }

  get value(): number {
    return (this.state ^ 0xffffffff) >>> 0
  }
}

/** 单缓冲顺序读 tar；显式分配最多 64 KiB，EOF/填充/额外内容必须检查。 */
export class ArchiveReader {
  private readonly iterator: AsyncIterator<unknown>
  private chunk: Buffer = Buffer.alloc(0)
  private offset = 0
  private readonly signal: AbortSignal | undefined

  constructor(source: AsyncIterable<unknown>, signal?: AbortSignal) {
    this.iterator = source[Symbol.asyncIterator]()
    this.signal = signal
  }

  async read(size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > BATCH_RESOURCES.maxBufferBytes) {
      throw new ArchiveError('invalid-request', '归档读取缓冲大小无效。')
    }
    const result = Buffer.alloc(size)
    let written = 0
    while (written < size) {
      checkArchiveAbort(this.signal)
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done) {
          throw new ArchiveError('invalid-archive', 'tar 成员或结束块被截断。')
        }
        if (!Buffer.isBuffer(next.value)) {
          throw new ArchiveError('invalid-archive', '归档流必须是二进制字节。')
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

  async expectEnd(): Promise<void> {
    if (this.offset !== this.chunk.length) {
      throw new ArchiveError('invalid-archive', 'tar 结束后存在多余内容。')
    }
    for (;;) {
      checkArchiveAbort(this.signal)
      const next = await this.iterator.next()
      if (next.done) {
        return
      }
      if (!Buffer.isBuffer(next.value) || next.value.length !== 0) {
        throw new ArchiveError('invalid-archive', 'tar 结束后存在多余内容。')
      }
    }
  }
}
