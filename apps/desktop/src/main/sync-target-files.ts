import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, rename, rmdir, statfs, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { syncNameKey } from '@savedata-sync/shared'
import type { SyncEntry } from '@savedata-sync/shared'
import type { NativeDirectoryLocation } from './directory-adapter.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import { hashBackupStream } from './backup-files.ts'

/** 写入目标用到的磁盘操作。 */
export interface SyncTargetIO {
  readonly link: typeof link
  readonly rename: typeof rename
  /** 创建一个目录，只有当前用户可访问。 */
  readonly mkdir: (path: string) => Promise<void>
  readonly unlink: typeof unlink
  /** 删除空目录；目录非空时系统拒绝。 */
  readonly rmdir: (path: string) => Promise<void>
  /** 把文件内容同步写入磁盘。 */
  readonly sync: (file: FileHandle) => Promise<void>
  /** 读取 path 所在磁盘的可用字节数；无法得知时为 null。 */
  readonly availableBytes: (path: string) => Promise<bigint | null>
}
/** 使用真实文件系统的写入磁盘操作。 */
export const SYNC_TARGET_IO: SyncTargetIO = {
  link,
  rename,
  unlink,
  rmdir: (path) => rmdir(path),
  mkdir: async (path) => {
    await mkdir(path, { mode: 0o700 })
  },
  sync: (file) => file.sync(),
  availableBytes: async (path) => {
    const value = await statfs(path, { bigint: true })
    return value.bavail * value.bsize
  },
}

/** 写入目标前的候选文件，位于已核实的父目录中。 */
export interface SyncCandidate {
  readonly parent: NativeDirectoryLocation
  readonly path: string
  readonly handle: FileHandle
  identity: FileIdentity | null
  isClosed: boolean
  hasCandidate: boolean
  linkedPath: string | null
}

/** 按共享的 NFC 小写键复核名称，实际操作仍用原始名称。 */
export async function checkTargetName(
  parent: NativeDirectoryLocation,
  name: string,
  shouldExist: boolean,
): Promise<void> {
  await parent.verify()
  const matches = (await readdir(parent.path)).filter(
    (item) => syncNameKey([item]) === syncNameKey([name]),
  )
  if (shouldExist ? matches.length !== 1 || matches[0] !== name : matches.length !== 0) {
    throw new ArchiveError('source-changed', 'The target name or type changed. Scan again.')
  }
  await parent.verify()
}

/** 有界回读目标文件，可选核对身份和日期；遇到链接或读取期间文件变化时抛错。 */
export async function verifyTargetFile(
  path: string,
  entry: SyncEntry,
  signal?: AbortSignal,
  identity?: FileIdentity,
  shouldCheckDate = true,
  expectedLinks = 1n,
): Promise<BigIntStats> {
  checkArchiveAbort(signal)
  const before = await inspectLocalPath(path)
  if (
    !before.isFile() ||
    before.nlink !== expectedLinks ||
    (identity && !hasSameIdentity(before, identity)) ||
    before.size !== BigInt(entry.sizeBytes ?? -1) ||
    (shouldCheckDate && Number(before.mtimeMs) !== entry.modifiedAt)
  ) {
    throw new ArchiveError('source-changed', 'The target file identity, size, or date changed.')
  }
  const file = await open(path, 'r')
  try {
    const opened = await file.stat({ bigint: true })
    if (!hasSameIdentity(opened, getFileIdentity(before))) {
      throw new ArchiveError('source-changed', 'The target was replaced while opening.')
    }
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536)
    let size = 0
    for (;;) {
      checkArchiveAbort(signal)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size)
      if (!bytesRead) {
        break
      }
      size += bytesRead
      if (size > (entry.sizeBytes ?? -1)) {
        throw new ArchiveError('source-changed', 'The target file length changed.')
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat({ bigint: true }),
      current = await inspectLocalPath(path)
    if (
      !hasSameIdentity(current, getFileIdentity(before)) ||
      current.nlink !== expectedLinks ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      current.mtimeNs !== after.mtimeNs ||
      current.ctimeNs !== after.ctimeNs ||
      size !== entry.sizeBytes ||
      hash.digest('hex') !== entry.sha256
    ) {
      throw new ArchiveError(
        'source-changed',
        'The target file content or attributes changed while reading.',
      )
    }
    return current
  } finally {
    await file.close()
  }
}

/** 创建候选文件；之后无论成败都要 cleanupCandidate。 */
export async function createCandidate(parent: NativeDirectoryLocation): Promise<SyncCandidate> {
  await parent.verify()
  const path = join(parent.path, `.savedata-copy-${randomUUID()}.tmp`)
  const handle = await open(path, 'wx', 0o600)
  return {
    parent,
    path,
    handle,
    identity: null,
    isClosed: false,
    hasCandidate: true,
    linkedPath: null,
  }
}

/** 把输入写入候选文件并落盘、回读核对；输入流由本函数读完并关闭。 */
export async function stageCandidate(
  candidate: SyncCandidate,
  entry: SyncEntry,
  input: Readable,
  verifySource: () => Promise<void>,
  io: SyncTargetIO,
  signal: AbortSignal,
): Promise<void> {
  const before = await candidate.handle.stat({ bigint: true })
  candidate.identity = getFileIdentity(before)
  if (!before.isFile() || before.nlink !== 1n) {
    throw new ArchiveError('source-changed', 'The candidate file identity is invalid.')
  }
  const actual = await hashBackupStream(input, entry.sizeBytes ?? -1, signal, async (chunk) => {
    await candidate.parent.verify()
    const available = await io.availableBytes(candidate.parent.path)
    if (available !== null && available < BigInt(chunk.length)) {
      throw new ArchiveError('insufficient-space', 'The target volume has insufficient space.')
    }
    for (let offset = 0; offset < chunk.length;) {
      checkArchiveAbort(signal)
      const written = await candidate.handle.write(chunk, offset, chunk.length - offset)
      if (!written.bytesWritten) {
        throw new ArchiveError('io-failure', 'The candidate write made no progress.')
      }
      offset += written.bytesWritten
    }
  })
  if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
    throw new ArchiveError(
      'checksum-mismatch',
      'The input content differs from the confirmed plan.',
    )
  }
  await verifySource()
  await io.sync(candidate.handle)
  await candidate.handle.close()
  candidate.isClosed = true
  await verifyTargetFile(candidate.path, entry, signal, candidate.identity, false)
}

/** 清理仍持有且身份匹配的候选文件；已发布的文件保留。 */
export async function cleanupCandidate(candidate: SyncCandidate, io: SyncTargetIO): Promise<void> {
  if (!candidate.isClosed) {
    candidate.identity ??= getFileIdentity(await candidate.handle.stat({ bigint: true }))
    await candidate.handle.close()
    candidate.isClosed = true
  }
  if (!candidate.hasCandidate) {
    return
  }
  await candidate.parent.verify()
  const value = await lstat(candidate.path, { bigint: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (value) {
    const linked = candidate.linkedPath
      ? await lstat(candidate.linkedPath, { bigint: true }).catch(() => null)
      : null
    const hasExpectedLinks =
      value.nlink === 1n ||
      (value.nlink === 2n &&
        linked !== null &&
        !linked.isSymbolicLink() &&
        candidate.identity !== null &&
        hasSameIdentity(linked, candidate.identity))
    if (
      !candidate.identity ||
      !value.isFile() ||
      value.isSymbolicLink() ||
      !hasExpectedLinks ||
      !hasSameIdentity(value, candidate.identity)
    ) {
      throw new ArchiveError('cleanup-failed', 'The candidate identity changed. Inspect leftovers.')
    }
    await io.unlink(candidate.path)
  }
  candidate.hasCandidate = false
}
