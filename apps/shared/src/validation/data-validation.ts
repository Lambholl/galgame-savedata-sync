/** 类型守卫函数。只处理已解析的普通数据，不防御 getter 和 Proxy，也不解析 JSON 文本。 */
export type ValueGuard<TValue> = (value: unknown) => value is TValue

/** 判断是否为普通对象；数组、类实例和继承自其他对象的容器都不算。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 检查对象的自有字段是否恰好是给定的字段；JSON 重复键要在解析层拒绝。 */
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

/** 校验字节计数：非负安全整数；0 表示实际的空文件，不是未知。 */
export function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 校验 Unix 毫秒时间戳：可以是零和负值，但必须落在可表示的日期范围内。 */
export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}

/** 校验可空值：未知值显式为 null，undefined 和缺失字段都不接受。 */
export function isNullable<TValue>(
  value: unknown,
  guard: ValueGuard<TValue>,
): value is TValue | null {
  return value === null || guard(value)
}

/** 逐项检查数组，包括空洞；长度和成员关系由调用方另外限制。 */
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

/** 校验枚举：必须是原始字符串，数组、对象和数字不做强制转换。 */
export function isOneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value)
}
