import type { AppLocale } from '../preferences/app-preferences.ts'

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

/** 格式化为带年份的日期和 24 小时制时间，精确到分钟，按界面语言排列。 */
export function formatDateTime(value: number, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value)
}

/** 按本地时区格式化为 yy-MM-dd HH:mm，各语言相同，等宽字体下上下行对齐。 */
export function formatShortDateTime(value: number): string {
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getFullYear() % 100)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
