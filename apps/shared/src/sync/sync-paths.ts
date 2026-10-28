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

/** 校验原始名称段及预算；可移植创建名由计划器另行检查。根用空数组单独表示。 */
export function isSyncPath(value: unknown): value is readonly string[] {
  return (
    isArrayOf(value, isName) &&
    value.length > 0 &&
    value.length <= SYNC_LIMITS.maxDepth &&
    value.reduce((length, segment) => length + segment.length + 1, -1) <= SYNC_LIMITS.maxPathLength
  )
}

/** 用 JSON 数组编码避免名称含分隔符时发生键碰撞；不生成平台路径。 */
export function syncPathKey(path: readonly string[]): string {
  return JSON.stringify(path)
}

/** 仅用于保守发现跨平台等价名称；原始路径不归一化、不改名。 */
export function syncNameKey(path: readonly string[]): string {
  return syncPathKey(path.map((segment) => segment.normalize('NFC').toLowerCase()))
}

/** 固定码元顺序，避免依赖运行环境语言和 localeCompare 的排序规则。 */
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
