import { createHash } from 'node:crypto'
import { open, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { BATCH_LIMITS, isPortableFileName } from '@savedata-sync/shared'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'

/** 备份用到的磁盘操作，只有主进程可以替换，用来验证容量不足和落盘失败。 */
export interface BackupDiskIO {
  readonly availableBytes: (path: string) => Promise<bigint | null>
  readonly sync: (handle: FileHandle) => Promise<void>
}
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

/** 一份备份的文件夹名：UTC 时间，与设备时区无关，按名字排序即按时间排序。 */
export function backupRoundName(createdAt: number): string {
  const time = new Date(createdAt).toISOString()
  return `${time.slice(0, 10)}_${time.slice(11, 19).replaceAll(':', '-')}Z`
}

/** 检查备份文件是否为无链接的普通文件并返回身份；同一文件有额外硬链接时停止读取。 */
export async function inspectBackupFile(path: string, maxBytes: number): Promise<FileIdentity> {
  const value = await inspectLocalPath(path)
  if (!value.isFile() || value.nlink !== 1n || value.size > BigInt(maxBytes)) {
    throw new ArchiveError('path-outside-root', 'A backup file has an invalid type, link, or size.')
  }
  return getFileIdentity(value)
}

/** 打开备份文件的读流，同时返回关闭后的变化检查。流归调用方，文件句柄随流关闭。 */
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

/** 流式计算 SHA-256。取消时关闭阻塞的输入，总是等输入释放后才返回。 */
export async function hashBackupStream(
  input: Readable,
  maxBytes: number,
  signal?: AbortSignal,
  write?: (chunk: Buffer) => Promise<void>,
): Promise<{ sizeBytes: number; sha256: string }> {
  const abort = (): void => {
    input.destroy(new Error('Backup reading was aborted.'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    checkArchiveAbort(signal)
    const hash = createHash('sha256')
    let sizeBytes = 0
    for await (const chunk of input) {
      checkArchiveAbort(signal)
      if (!Buffer.isBuffer(chunk) || chunk.length > 65536 || sizeBytes + chunk.length > maxBytes) {
        throw new ArchiveError('resource-limit', 'The backup file exceeds the resource budget.')
      }
      sizeBytes += chunk.length
      hash.update(chunk)
      await write?.(chunk)
    }
    checkArchiveAbort(signal)
    return { sizeBytes, sha256: hash.digest('hex') }
  } finally {
    signal?.removeEventListener('abort', abort)
    input.destroy()
    await finished(input).catch(() => {
      /* 主错误由原读取过程报告。 */
    })
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

/** 独占创建固定名称的 JSON 文件，同步落盘后关闭；失败时由外层持有这一轮备份的代码清理。 */
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
