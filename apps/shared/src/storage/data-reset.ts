/** 启动时因内容读不懂而改用默认值的数据项。 */
export type DataResetItem =
  | 'device-identity'
  | 'directories'
  | 'library'
  | 'backup-settings'
  | 'backup-library'
  | 'service-settings'
  | 'preferences'

/** 全部数据项，按提示里的显示顺序排列。 */
export const DATA_RESET_ITEMS: readonly DataResetItem[] = [
  'device-identity',
  'directories',
  'library',
  'backup-settings',
  'backup-library',
  'service-settings',
  'preferences',
]

/** 校验重置项列表：每项是已知数据项且不重复。 */
export function isDataResetList(value: unknown): value is readonly DataResetItem[] {
  return (
    Array.isArray(value) &&
    value.every((item) => (DATA_RESET_ITEMS as readonly unknown[]).includes(item)) &&
    new Set(value).size === value.length
  )
}

/**
 * 读不懂的数据文件改名后的文件名：`<名称>.unreadable-<UTC 时间>.<扩展名>`，时间形如 `20261123T081530Z`。
 *
 * @param fileName 原文件名，不含目录；没有扩展名时结果也没有扩展名。
 * @param now 毫秒时间戳。
 */
export function unreadableFileName(fileName: string, now: number): string {
  const time = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const dot = fileName.lastIndexOf('.')
  return dot > 0
    ? `${fileName.slice(0, dot)}.unreadable-${time}${fileName.slice(dot)}`
    : `${fileName}.unreadable-${time}`
}
