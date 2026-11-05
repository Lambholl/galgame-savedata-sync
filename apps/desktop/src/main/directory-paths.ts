import { lstat, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { DirectoryAccessError } from './directory-errors.ts'

/** 目录或条目当前的身份，用来发现引用被替换。 */
export interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

/** bigint 文件身份转为可持久化的字符串，避免 Windows 文件 ID 的整数精度损失。 */
export function getFileIdentity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev.toString(), ino: stats.ino.toString() }
}

/** 比较两个文件对象是否同一个；只看身份，内容相同与否要另外校验。 */
export function hasSameIdentity(stats: BigIntStats, identity: FileIdentity): boolean {
  return stats.dev.toString() === identity.dev && stats.ino.toString() === identity.ino
}

/** 判断目标路径是否在根目录内，按当前平台规则比较；前缀相同的兄弟目录不算在内。 */
export function isWithinDirectory(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/**
 * 逐段 lstat 并核对 realpath，遇到 symlink、junction 或路径越界时拒绝；不遍历目录后代。
 * 这是操作前的检查，检查之后路径仍可能被外部进程替换。
 */
export async function inspectLocalPath(path: string): Promise<BigIntStats> {
  if (!isAbsolute(path)) {
    throw new DirectoryAccessError('invalid-request', 'The directory path must be absolute.')
  }
  const absolutePath = resolve(path)
  let currentPath = parse(absolutePath).root
  let stats = await lstat(currentPath, { bigint: true })
  for (const segment of relative(currentPath, absolutePath).split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, segment)
    stats = await lstat(currentPath, { bigint: true })
    if (stats.isSymbolicLink()) {
      throw new DirectoryAccessError(
        'path-outside-root',
        'Access through symbolic links or directory junctions is not supported.',
      )
    }
  }
  const canonicalPath = await realpath(absolutePath)
  if (relative(absolutePath, canonicalPath) !== '') {
    throw new DirectoryAccessError(
      'path-outside-root',
      'The actual directory location does not match the registered path.',
    )
  }
  return stats
}
