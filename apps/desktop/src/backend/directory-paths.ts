import { lstat, realpath } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { DirectoryAccessError } from './directory-errors.ts'

/** 目录或条目当前的身份，用来发现引用被替换。 */
export interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

/** 把 bigint 形式的文件身份转成可保存的字符串，保留完整精度。 */
export function getFileIdentity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev.toString(), ino: stats.ino.toString() }
}

/** 判断 stats 与 identity 是否是同一个文件对象；只比较身份。 */
export function hasSameIdentity(stats: BigIntStats, identity: FileIdentity): boolean {
  return stats.dev.toString() === identity.dev && stats.ino.toString() === identity.ino
}

/** 按当前平台的路径规则判断目标路径是否在根目录内，根目录本身也算。 */
export function isWithinDirectory(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/**
 * 逐段检查路径并核对 realpath，路径上有 symlink、junction 或越界时抛错。
 * 结果只反映检查那一刻的状态。
 *
 * @returns 路径最后一段的 lstat 结果。
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
