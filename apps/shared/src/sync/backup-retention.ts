/** 每个游戏、每台设备最多保留的覆盖前备份份数的范围与默认值。 */
export const BACKUP_KEEP_COUNT_MIN = 1
export const BACKUP_KEEP_COUNT_MAX = 10
export const DEFAULT_BACKUP_KEEP_COUNT = 3

export function isBackupKeepCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= BACKUP_KEEP_COUNT_MIN &&
    value <= BACKUP_KEEP_COUNT_MAX
  )
}
