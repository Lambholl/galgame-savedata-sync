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

/** 校验原始名称段和长度上限；可移植的创建名由计划器另外检查。根用空数组表示。 */
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

/** 生成跨平台等价名称的比较键，只用来发现冲突；原始路径不归一化，也不改名。 */
export function syncNameKey(path: readonly string[]): string {
  return syncPathKey(path.map((segment) => segment.normalize('NFC').toLowerCase()))
}

/** 按固定码元顺序比较路径，结果不受运行环境语言和 localeCompare 影响。 */
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
