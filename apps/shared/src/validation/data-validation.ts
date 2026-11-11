/** 校验已解析的普通数据的类型守卫。 */
export type ValueGuard<TValue> = (value: unknown) => value is TValue

/** 判断是否为原型是 Object.prototype 或 null 的普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 检查对象的自有字段是否恰好是给定的字段。 */
export function hasShape(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

/** 校验展示文本：非空白，最长 1024 个 UTF-16 码元，没有未配对的代理项。 */
export function isText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 1024 &&
    !/[\uD800-\uDFFF]/u.test(value)
  )
}

/** 校验字节计数：非负安全整数。 */
export function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 校验 Unix 毫秒时间戳：在 Date 可表示的范围内，可以是零和负值。 */
export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}

/** 校验可空值：null 或通过 guard 的值。 */
export function isNullable<TValue>(
  value: unknown,
  guard: ValueGuard<TValue>,
): value is TValue | null {
  return value === null || guard(value)
}

/** 逐项检查数组，空洞按 undefined 校验。 */
export function isArrayOf<TValue>(value: unknown, guard: ValueGuard<TValue>): value is TValue[] {
  if (!Array.isArray(value)) {
    return false
  }
  for (const item of value) {
    if (!guard(item)) {
      return false
    }
  }
  return true
}

/** 校验枚举：value 是 choices 中的某个字符串。 */
export function isOneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value)
}
