const UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const

/** 按二进制单位格式化字节数，单位符号各语言通用；小于 1 KiB 显示整数，其余保留一位小数。 */
export function formatBytes(value: number): string {
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024
    unit++
  }
  return unit === 0 ? `${value} ${UNITS[0]}` : `${amount.toFixed(1)} ${UNITS[unit]}`
}

// 日期和时间都用固定格式，不随界面语言和系统区域变化，所以不经过 Intl 和 toLocale*。
function pad(part: number): string {
  return String(part).padStart(2, '0')
}

/** 按本地时区格式化为 MM-dd。 */
export function formatMonthDay(value: number): string {
  const date = new Date(value)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 按本地时区格式化为 24 小时制的 HH:mm。 */
export function formatTimeOfDay(value: number): string {
  const date = new Date(value)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 按本地时区格式化为 yy-MM-dd HH:mm，等宽字体下上下行对齐。 */
export function formatShortDateTime(value: number): string {
  const date = new Date(value)
  return `${pad(date.getFullYear() % 100)}-${formatMonthDay(value)} ${formatTimeOfDay(value)}`
}
