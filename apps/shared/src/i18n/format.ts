import type { AppLocale } from '../preferences/app-preferences.ts'

const UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const

/**
 * 字节按二进制单位显示，单位符号各语言通用；小于 1 KiB 显示整数，其余保留一位小数。
 * 未知大小由调用方显示对应文案。
 */
export function formatBytes(value: number): string {
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024
    unit++
  }
  return unit === 0 ? `${value} ${UNITS[0]}` : `${amount.toFixed(1)} ${UNITS[unit]}`
}

/** 带年份的日期与 24 小时制时间，精确到分钟，按界面语言排列。 */
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

/** 列表里的短时间：同一年省略年份。 */
export function formatShortDateTime(value: number, locale: AppLocale, now: number): string {
  const isSameYear = new Date(value).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    ...(isSameYear ? {} : { year: '2-digit' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value)
}
