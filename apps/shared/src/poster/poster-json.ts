import { isRecord } from '../validation/data-validation.ts'

/** 解析响应体；不是 JSON 时返回 undefined。 */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    // 来源偶尔返回 HTML 错误页，由调用方按格式不符处理。
    return undefined
  }
}

/** 取去掉首尾空白后非空的字符串；其他值返回 null。 */
export function readText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  return text === '' ? null : text
}

/** 取对象字段；value 不是普通对象时返回 undefined。 */
export function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** 取数组字段；不是数组时返回 null。 */
export function readArray(value: unknown, key: string): readonly unknown[] | null {
  const field = readField(value, key)
  return Array.isArray(field) ? field : null
}

/** 用 “ · ” 连接非空的部分；都为空时返回 null。 */
export function joinDetail(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null)
  return present.length === 0 ? null : present.join(' · ')
}

/** 副标题与标题相同时返回 null。 */
export function distinctSubtitle(title: string, subtitle: string | null): string | null {
  return subtitle === title ? null : subtitle
}

/** 生成宽×高的尺寸文字；宽或高不是正整数时返回 null。 */
export function sizeText(width: unknown, height: unknown): string | null {
  const isPositive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  return isPositive(width) && isPositive(height) ? `${width}×${height}` : null
}

/** 把查询参数编码成 `a=1&b=2`。 */
export function encodeQuery(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}
