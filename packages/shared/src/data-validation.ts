/** 只处理已解析的普通数据，不执行 getter/Proxy 防御或 JSON 文本解析。 */
export type ValueGuard<TValue> = (value: unknown) => value is TValue

/** 拒绝数组、类实例和继承自其他对象的容器；不修改输入。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 检查封闭对象的自有字段；JSON 重复键必须在解析层拒绝。 */
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

/** 展示文本非空白，最长 1024 个 UTF-16 码元，拒绝未配对代理项。 */
export function isText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 1024 &&
    !/[\uD800-\uDFFF]/u.test(value)
  )
}

/** 字节计数只能为非负安全整数；0 表示实际空文件而非未知。 */
export function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Unix 毫秒允许零与负值，但必须落在可表示日期范围。 */
export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}

/** 未知值显式为 null，不接受 undefined 或缺失字段。 */
export function isNullable<TValue>(
  value: unknown,
  guard: ValueGuard<TValue>,
): value is TValue | null {
  return value === null || guard(value)
}

/** 逐项检查数组，包含空洞；调用方另行限制长度和成员关系。 */
export function isArrayOf<TValue>(value: unknown, guard: ValueGuard<TValue>): value is TValue[] {
  if (!Array.isArray(value)) return false
  for (const item of value) if (!guard(item)) return false
  return true
}

/** 枚举必须是原始字符串，不将数组、对象或数字强制转换为协议字面量。 */
export function isOneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value)
}
