import { isArrayOf } from '../validation/data-validation.ts'
import { SYNC_LIMITS } from './sync-contracts.ts'

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SYNC_LIMITS.maxNameLength &&
    value !== '.' &&
    value !== '..' &&
    !value.includes(String.fromCharCode(0)) &&
    !/[/\\\uD800-\uDFFF]/u.test(value)
  )
}

/** 校验由原始名称段组成的路径和长度上限；根目录是空数组。 */
export function isSyncPath(value: unknown): value is readonly string[] {
  return (
    isArrayOf(value, isName) &&
    value.length > 0 &&
    value.length <= SYNC_LIMITS.maxDepth &&
    value.reduce((length, segment) => length + segment.length + 1, -1) <= SYNC_LIMITS.maxPathLength
  )
}

/** 生成路径的比较键：用 JSON 数组编码，名称含分隔符时也不会碰撞。 */
export function syncPathKey(path: readonly string[]): string {
  return JSON.stringify(path)
}

/** 生成忽略跨平台等价差异的比较键，用于发现名称冲突。 */
export function syncNameKey(path: readonly string[]): string {
  return syncPathKey(path.map((segment) => segment.normalize('NFC').toLowerCase()))
}

/** 按 UTF-16 码元顺序比较路径，结果与运行环境的语言无关。 */
export function compareSyncPaths(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return left.length - right.length
}
