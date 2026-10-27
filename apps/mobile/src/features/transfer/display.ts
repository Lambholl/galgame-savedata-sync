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
