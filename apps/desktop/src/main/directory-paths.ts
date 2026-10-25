import { lstat, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { DirectoryAccessError } from './directory-errors.ts'

/** 目录/条目当前身份；仅用于发现引用被替换，不保存文件内容或同步历史。 */
export interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

/** bigint 文件身份转为可持久化的字符串，避免 Windows 文件 ID 的整数精度损失。 */
export function getFileIdentity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev.toString(), ino: stats.ino.toString() }
}

/** 只比较对象身份，不用日期或大小判断内容是否相同。 */
export function hasSameIdentity(stats: BigIntStats, identity: FileIdentity): boolean {
  return stats.dev.toString() === identity.dev && stats.ino.toString() === identity.ino
}

/** 路径比较按当前平台规则执行；兄弟目录的同名前缀不属于根内。 */
export function isWithinDirectory(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/**
 * 逐段 lstat 并核对 realpath，拒绝 symlink/junction 和路径越界；不遍历目录后代。
 * 这是 Node 路径 API 的操作前检查，不提供对外部恶意并发更换命名空间的原子隔离。
 */
export async function inspectLocalPath(path: string): Promise<BigIntStats> {
  if (!isAbsolute(path)) throw new DirectoryAccessError('invalid-request', '目录必须是绝对路径。')
  const absolutePath = resolve(path)
  let currentPath = parse(absolutePath).root
  let stats = await lstat(currentPath, { bigint: true })
  for (const segment of relative(currentPath, absolutePath).split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, segment)
    stats = await lstat(currentPath, { bigint: true })
    if (stats.isSymbolicLink()) {
      throw new DirectoryAccessError('path-outside-root', '不支持通过符号链接或目录联接访问文件。')
    }
  }
  const canonicalPath = await realpath(absolutePath)
  if (relative(absolutePath, canonicalPath) !== '') {
    throw new DirectoryAccessError('path-outside-root', '目录实际位置与登记路径不一致。')
  }
  return stats
}
