import { createHash } from 'node:crypto'
import { open, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { BATCH_LIMITS } from '@savedata-sync/shared'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'

/** 仅主进程可替换的磁盘能力，用于容量和落盘失败的原生验证。 */
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

/** 私有备份只访问无链接的普通文件；同一文件有额外硬链接时停止读取或清理。 */
export async function inspectBackupFile(path: string, maxBytes: number): Promise<FileIdentity> {
  const value = await inspectLocalPath(path)
  if (!value.isFile() || value.nlink !== 1n || value.size > BigInt(maxBytes)) {
    throw new ArchiveError('path-outside-root', '备份文件类型、链接或大小无效。')
  }
  return getFileIdentity(value)
}

/** 返回原生读流和关闭后的变化检查；调用方拥有流，文件句柄随流关闭。 */
export async function openBackupFile(
  path: string,
  maxBytes: number,
  expected?: FileIdentity,
): Promise<{ stream: Readable; verify: () => Promise<void> }> {
  const identity = await inspectBackupFile(path, maxBytes)
  if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
    throw new ArchiveError('source-changed', '备份文件身份已变化。')
  }
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!hasSameIdentity(before, identity) || !before.isFile() || before.nlink !== 1n) {
      throw new ArchiveError('source-changed', '备份文件在打开时变化。')
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
          throw new ArchiveError('source-changed', '备份文件在读取期间变化。')
        }
      },
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** 流式 SHA-256，取消会关闭阻塞的输入；始终等待输入释放后返回。 */
export async function hashBackupStream(
  input: Readable,
  maxBytes: number,
  signal?: AbortSignal,
  write?: (chunk: Buffer) => Promise<void>,
): Promise<{ sizeBytes: number; sha256: string }> {
  const abort = (): void => {
    input.destroy(new Error('备份读取已中止。'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    checkArchiveAbort(signal)
    const hash = createHash('sha256')
    let sizeBytes = 0
    for await (const chunk of input) {
      checkArchiveAbort(signal)
      if (!Buffer.isBuffer(chunk) || chunk.length > 65536 || sizeBytes + chunk.length > maxBytes) {
        throw new ArchiveError('resource-limit', '备份文件超过资源预算。')
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

/** 元数据有独立字节上限，并以严格 UTF-8 解码；不会读取文件内容到 JS 桥。 */
export async function readBackupJson(path: string): Promise<unknown> {
  const file = await openBackupFile(path, BATCH_LIMITS.maxJsonBytes)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of file.stream) {
      if (!Buffer.isBuffer(chunk) || (size += chunk.length) > BATCH_LIMITS.maxJsonBytes) {
        throw new ArchiveError('resource-limit', '备份元数据超过限制。')
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

/** 独占创建固定内部文件；同步落盘后关闭，失败由外层轮次所有者清理。 */
export async function writeBackupJson(
  path: string,
  value: unknown,
  io: BackupDiskIO,
): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > BATCH_LIMITS.maxJsonBytes) {
    throw new ArchiveError('resource-limit', '备份元数据超过限制。')
  }
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await io.sync(handle)
  } finally {
    await handle.close()
  }
}
