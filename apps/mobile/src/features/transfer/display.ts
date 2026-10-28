/** 字节按二进制单位显示；缺失值保留未知状态。 */
export function displayBytes(value: number | null): string {
  return value === null
    ? '未知'
    : value < 1024
      ? `${value} B`
      : value < 1048576
        ? `${(value / 1024).toFixed(1)} KiB`
        : `${(value / 1048576).toFixed(1)} MiB`
}

/** 目录时间显示到分钟，保留年份与日期。 */
export function displayTime(value: number | null): string {
  return value === null
    ? '时间未知'
    : new Date(value).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
}

/** 文件列表用短日期和分钟时间；仅缩短展示，不改变原始时间值。 */
export function displayFileTime(value: number | null): string {
  if (value === null) {
    return '时间未知'
  }
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getFullYear() % 100)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 文件列表使用紧凑的二进制 B/K/M/G 单位，未知大小仍明确标识。 */
export function displayFileBytes(value: number | null): string {
  if (value === null) {
    return '大小未知'
  }
  if (value < 1024) {
    return `${value}B`
  }
  const unit = value < 1048576 ? 'K' : value < 1073741824 ? 'M' : 'G'
  const divisor = unit === 'K' ? 1024 : unit === 'M' ? 1048576 : 1073741824
  return `${(value / divisor).toFixed(2)}${unit}`
}
