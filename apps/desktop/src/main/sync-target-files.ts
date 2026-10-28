import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises'
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

/** 原生故障/容量接口；不能由 HTTP、IPC 或已确认计划指定。 */
export interface SyncTargetIO {
  readonly link: typeof link
  readonly rename: typeof rename
  readonly mkdir: (path: string) => Promise<void>
  readonly unlink: typeof unlink
  readonly sync: (file: FileHandle) => Promise<void>
  readonly availableBytes: (path: string) => Promise<bigint | null>
}
export const SYNC_TARGET_IO: SyncTargetIO = {
  link,
  rename,
  unlink,
  mkdir: async (path) => {
    await mkdir(path, { mode: 0o700 })
  },
  sync: (file) => file.sync(),
  availableBytes: async (path) => {
    const value = await statfs(path, { bigint: true })
    return value.bavail * value.bsize
  },
}

/** 路径始终由已核实父目录和单个计划名称组成；句柄和候选只在当前进程有效。 */
export interface SyncCandidate {
  readonly parent: NativeDirectoryLocation
  readonly path: string
  readonly handle: FileHandle
  identity: FileIdentity | null
  isClosed: boolean
  hasCandidate: boolean
  linkedPath: string | null
}

/** 名称按共享 NFC/小写键复核，实际操作保持原始名称。 */
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
    throw new ArchiveError('source-changed', '目标名称或类型已变化，请重新扫描。')
  }
  await parent.verify()
}

/** 有界独立读回；可核对原身份和日期，拒绝链接以及读取期间变化。 */
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
    throw new ArchiveError('source-changed', '目标文件身份、大小或日期已变化。')
  }
  const file = await open(path, 'r')
  try {
    const opened = await file.stat({ bigint: true })
    if (!hasSameIdentity(opened, getFileIdentity(before))) {
      throw new ArchiveError('source-changed', '目标在打开时已被替换。')
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
        throw new ArchiveError('source-changed', '目标文件长度已变化。')
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
      throw new ArchiveError('source-changed', '目标文件内容或读取期间属性已变化。')
    }
    return current
  } finally {
    await file.close()
  }
}

/** 创建后立即登记句柄所有权；调用方即使写入失败也必须 cleanupCandidate。 */
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

/** 原生输入由本函数消费并关闭，64 KiB 分块，落盘及独立回读均通过后才可发布。 */
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
    throw new ArchiveError('source-changed', '候选文件身份无效。')
  }
  const actual = await hashBackupStream(input, entry.sizeBytes ?? -1, signal, async (chunk) => {
    await candidate.parent.verify()
    const available = await io.availableBytes(candidate.parent.path)
    if (available !== null && available < BigInt(chunk.length)) {
      throw new ArchiveError('insufficient-space', '目标卷空间不足。')
    }
    for (let offset = 0; offset < chunk.length;) {
      checkArchiveAbort(signal)
      const written = await candidate.handle.write(chunk, offset, chunk.length - offset)
      if (!written.bytesWritten) {
        throw new ArchiveError('io-failure', '候选写入没有进展。')
      }
      offset += written.bytesWritten
    }
  })
  if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
    throw new ArchiveError('checksum-mismatch', '输入内容与确认计划不同。')
  }
  await verifySource()
  await io.sync(candidate.handle)
  await candidate.handle.close()
  candidate.isClosed = true
  await verifyTargetFile(candidate.path, entry, signal, candidate.identity, false)
}

/** 最终文件绝不在清理中删除；只删除本实例仍持有且原身份匹配的候选。 */
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
      throw new ArchiveError('cleanup-failed', '候选身份已变化，请核实残留。')
    }
    await io.unlink(candidate.path)
  }
  candidate.hasCandidate = false
}
