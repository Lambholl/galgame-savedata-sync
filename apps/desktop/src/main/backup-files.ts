import { open, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { BATCH_LIMITS, isPortableFileName } from '@savedata-sync/shared'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'

/** 备份用到的磁盘操作。 */
export interface BackupDiskIO {
  /** 读取 path 所在磁盘的可用字节数；无法得知时为 null。 */
  readonly availableBytes: (path: string) => Promise<bigint | null>
  /** 把文件内容同步写入磁盘。 */
  readonly sync: (handle: FileHandle) => Promise<void>
}
/** 使用真实文件系统的备份磁盘操作。 */
export const BACKUP_DISK_IO: BackupDiskIO = {
  availableBytes: async (path) => {
    const value = await statfs(path, { bigint: true })
    return value.bavail * value.bsize
  },
  sync: (handle) => handle.sync(),
}

const MAX_FOLDER_NAME_LENGTH = 60

/** 游戏名对应的文件夹名：换掉不能用的字符，过长截断；结果仍不可用时退回游戏 ID。 */
export function backupFolderName(gameName: string | null, projectId: string): string {
  if (gameName === null) {
    return projectId
  }
  const name = [...gameName]
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 || '<>:"/\\|?*'.includes(character) ? '_' : character
    })
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
  return isPortableFileName(name) ? name : projectId
}

/** 一份备份的文件夹名：UTC 时间，按名字排序就是按时间排序。 */
export function backupRoundName(createdAt: number): string {
  const time = new Date(createdAt).toISOString()
  return `${time.slice(0, 10)}_${time.slice(11, 19).replaceAll(':', '-')}Z`
}

/** 确认备份文件是没有额外硬链接、不超过 maxBytes 的普通文件，并返回它的身份；不符合时抛错。 */
export async function inspectBackupFile(path: string, maxBytes: number): Promise<FileIdentity> {
  const value = await inspectLocalPath(path)
  if (!value.isFile() || value.nlink !== 1n || value.size > BigInt(maxBytes)) {
    throw new ArchiveError('path-outside-root', 'A backup file has an invalid type, link, or size.')
  }
  return getFileIdentity(value)
}

/**
 * 打开备份文件的读流。流由调用方关闭，文件句柄随流关闭。
 *
 * @param expected 给出时，文件身份不同就抛出 source-changed 错误。
 * @returns 读流，以及在流关闭后确认文件没有变化的 verify。
 */
export async function openBackupFile(
  path: string,
  maxBytes: number,
  expected?: FileIdentity,
): Promise<{ stream: Readable; verify: () => Promise<void> }> {
  const identity = await inspectBackupFile(path, maxBytes)
  if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
    throw new ArchiveError('source-changed', 'The backup file identity changed.')
  }
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!hasSameIdentity(before, identity) || !before.isFile() || before.nlink !== 1n) {
      throw new ArchiveError('source-changed', 'The backup file changed while opening.')
    }
    return {
      stream: handle.createReadStream({ autoClose: true, highWaterMark: 65536 }),
      verify: async () => {
        const after = await inspectLocalPath(path)
        if (
          !hasSameIdentity(after, identity) ||
          !after.isFile() ||
          after.nlink !== 1n ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs
        ) {
          throw new ArchiveError('source-changed', 'The backup file changed while reading.')
        }
      },
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * 读完输入流并统计字节数，每块交给 write。取消时关闭输入流，等输入流释放后才返回。
 *
 * @throws ArchiveError 读到的字节超过 maxBytes 时抛 resource-limit。
 */
export async function copyStream(
  input: Readable,
  maxBytes: number,
  signal?: AbortSignal,
  write?: (chunk: Buffer) => Promise<void>,
): Promise<number> {
  const abort = (): void => {
    input.destroy(new Error('Backup reading was aborted.'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    checkArchiveAbort(signal)
    let sizeBytes = 0
    for await (const chunk of input) {
      checkArchiveAbort(signal)
      if (!Buffer.isBuffer(chunk) || chunk.length > 65536 || sizeBytes + chunk.length > maxBytes) {
        throw new ArchiveError('resource-limit', 'The file exceeds the resource budget.')
      }
      sizeBytes += chunk.length
      await write?.(chunk)
    }
    checkArchiveAbort(signal)
    return sizeBytes
  } finally {
    signal?.removeEventListener('abort', abort)
    input.destroy()
    await finished(input).catch(() => {
      /* 主错误由原读取过程报告。 */
    })
  }
}

// 不超过这个大小的文件整个读进内存后一次写出：存档多是小文件，分块读写的往返次数占了大部分耗时。
const WHOLE_FILE_BYTES = 16 * 1024 * 1024
const COPY_CHUNK_BYTES = 1024 * 1024

/**
 * 把 source 复制成新文件 destination，并把 destination 的修改日期设为 source 的。返回时数据可能还在系统缓存里。
 * 复制前后 source 的大小和修改日期都必须等于 expected，读到的字节数也必须等于 expected.sizeBytes。
 *
 * @param onBytes 每写出一段后收到这段的字节数；抛出的异常让复制失败。
 * @throws ArchiveError source 的大小、修改日期或读到的字节数和 expected 不同时抛 source-changed。
 * @throws destination 已存在时抛系统的 EEXIST；失败时可能留下不完整的 destination，由调用方删除。
 */
export async function copyFileChecked(
  source: string,
  destination: string,
  expected: { readonly sizeBytes: number; readonly modifiedAt: number | null },
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  checkArchiveAbort(signal)
  const input = await open(source, 'r')
  try {
    const check = async (): Promise<BigIntStats> => {
      const value = await input.stat({ bigint: true })
      if (
        value.size !== BigInt(expected.sizeBytes) ||
        Number(value.mtimeMs) !== expected.modifiedAt
      ) {
        throw new ArchiveError('source-changed', 'The file size or date changed after the scan.')
      }
      return value
    }
    const before = await check()
    const output = await open(destination, 'wx', 0o600)
    try {
      let sizeBytes = 0
      if (expected.sizeBytes <= WHOLE_FILE_BYTES) {
        const data = await input.readFile()
        sizeBytes = data.length
        checkArchiveAbort(signal)
        await output.writeFile(data)
        onBytes?.(data.length)
      } else {
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
        for (;;) {
          checkArchiveAbort(signal)
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
          if (!bytesRead) {
            break
          }
          sizeBytes += bytesRead
          if (sizeBytes > expected.sizeBytes) {
            break
          }
          for (let offset = 0; offset < bytesRead;) {
            const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset)
            if (!bytesWritten) {
              throw new ArchiveError('io-failure', 'The file write made no progress.')
            }
            offset += bytesWritten
          }
          onBytes?.(bytesRead)
        }
      }
      if (sizeBytes !== expected.sizeBytes) {
        throw new ArchiveError('source-changed', 'The file length changed while copying.')
      }
      await check()
      await output.utimes(before.atime, before.mtime)
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}

/** 读取备份元数据 JSON：有独立的字节上限，按严格 UTF-8 解码。 */
export async function readBackupJson(path: string): Promise<unknown> {
  const file = await openBackupFile(path, BATCH_LIMITS.maxJsonBytes)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of file.stream) {
      if (!Buffer.isBuffer(chunk) || (size += chunk.length) > BATCH_LIMITS.maxJsonBytes) {
        throw new ArchiveError('resource-limit', 'Backup metadata exceeds the limit.')
      }
      chunks.push(chunk)
    }
    await file.verify()
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown
  } finally {
    file.stream.destroy()
    await finished(file.stream).catch(() => {
      /* 解码错误由调用方保留。 */
    })
  }
}

/** 以独占方式创建 JSON 文件，同步落盘后关闭；失败时已创建的文件保留。 */
export async function writeBackupJson(
  path: string,
  value: unknown,
  io: BackupDiskIO,
): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > BATCH_LIMITS.maxJsonBytes) {
    throw new ArchiveError('resource-limit', 'Backup metadata exceeds the limit.')
  }
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await io.sync(handle)
  } finally {
    await handle.close()
  }
}
