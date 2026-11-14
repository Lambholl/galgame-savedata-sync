import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, rename, rmdir, statfs, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { isWriteCandidateName, writeCandidateName } from '@savedata-sync/shared'
import type { SyncEntry } from '@savedata-sync/shared'
import type { NativeDirectoryLocation } from './directory-adapter.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'
import { ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import { copyStream } from './backup-files.ts'

/** 写入目标用到的磁盘操作。 */
export interface SyncTargetIO {
  readonly link: typeof link
  readonly rename: typeof rename
  /** 创建一个目录，只有当前用户可访问。 */
  readonly mkdir: (path: string) => Promise<void>
  readonly unlink: typeof unlink
  /** 删除空目录；目录非空时系统拒绝。 */
  readonly rmdir: (path: string) => Promise<void>
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

/**
 * 核对目标文件仍是计划里的样子：普通文件、链接数为 expectedLinks，大小和修改时间与 entry 相同；
 * 传入 identity 时还要求是同一个文件。不读内容。
 *
 * @throws ArchiveError 任一项不符时抛 source-changed。
 */
export async function checkTargetFile(
  path: string,
  entry: SyncEntry,
  identity?: FileIdentity,
  expectedLinks = 1n,
): Promise<BigIntStats> {
  const current = await inspectLocalPath(path)
  if (
    !current.isFile() ||
    current.nlink !== expectedLinks ||
    (identity && !hasSameIdentity(current, identity)) ||
    current.size !== BigInt(entry.sizeBytes ?? -1) ||
    Number(current.mtimeMs) !== entry.modifiedAt
  ) {
    throw new ArchiveError('source-changed', 'The target file identity, size, or date changed.')
  }
  return current
}

/**
 * 删除 root 及其子目录里名称符合 isWriteCandidateName 的普通文件，不进入链接指向的目录。
 * 调用方必须持有写入名额，否则可能删掉正在写入的候选文件。
 * 单个文件删不掉时跳过它；读不到目录或 signal 中止时抛错。
 */
export async function removeLeftoverCandidates(
  root: NativeDirectoryLocation,
  io: SyncTargetIO,
  signal: AbortSignal,
): Promise<void> {
  await root.verify()
  const directories = [root.path]
  for (let directory = directories.pop(); directory; directory = directories.pop()) {
    checkArchiveAbort(signal)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        directories.push(path)
      } else if (entry.isFile() && isWriteCandidateName(entry.name)) {
        await io.unlink(path).catch(() => {
          /* 删不掉的残留不影响写入：扫描会跳过它，下一次写入再删。 */
        })
      }
    }
  }
}

/** 创建候选文件；之后无论成败都要 cleanupCandidate。 */
export async function createCandidate(parent: NativeDirectoryLocation): Promise<SyncCandidate> {
  await parent.verify()
  const path = join(parent.path, writeCandidateName('copy', randomUUID()))
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

/**
 * 把输入写入候选文件，核对写入的字节数等于 entry.sizeBytes，再把候选文件的修改日期设为
 * entry.modifiedAt（为 null 时保留写入时的日期）。返回时数据可能还在系统缓存里。输入流由本函数读完并关闭。
 *
 * @throws ArchiveError 字节数和计划不同时抛 checksum-mismatch。
 */
export async function stageCandidate(
  candidate: SyncCandidate,
  entry: SyncEntry,
  input: Readable,
  verifySource: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const before = await candidate.handle.stat({ bigint: true })
  candidate.identity = getFileIdentity(before)
  if (!before.isFile() || before.nlink !== 1n) {
    throw new ArchiveError('source-changed', 'The candidate file identity is invalid.')
  }
  const sizeBytes = await copyStream(input, entry.sizeBytes ?? -1, signal, async (chunk) => {
    for (let offset = 0; offset < chunk.length;) {
      checkArchiveAbort(signal)
      const written = await candidate.handle.write(chunk, offset, chunk.length - offset)
      if (!written.bytesWritten) {
        throw new ArchiveError('io-failure', 'The candidate write made no progress.')
      }
      offset += written.bytesWritten
    }
  })
  if (sizeBytes !== entry.sizeBytes) {
    throw new ArchiveError('checksum-mismatch', 'The input length differs from the confirmed plan.')
  }
  await verifySource()
  if (entry.modifiedAt !== null) {
    // 下次比较按大小和修改日期判断，目标要带上来源的修改日期才会被认为相同。
    await candidate.handle.utimes(new Date(), new Date(entry.modifiedAt))
  }
  await candidate.handle.close()
  candidate.isClosed = true
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
