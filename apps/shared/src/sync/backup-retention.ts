import { hasShape } from '../validation/data-validation.ts'
import { BACKUP_SETTINGS_SCHEMA_VERSION } from './sync-contracts.ts'
import type { SyncBackupSettings } from './sync-contracts.ts'

/** 每个游戏保留备份份数的下限。 */
export const BACKUP_KEEP_COUNT_MIN = 1
/** 每个游戏保留备份份数的上限。 */
export const BACKUP_KEEP_COUNT_MAX = 4096
/** 每个游戏默认保留的备份份数。 */
export const DEFAULT_BACKUP_KEEP_COUNT = 10

/** 没有设置文件时的备份库设置：保留 DEFAULT_BACKUP_KEEP_COUNT 份。 */
export const DEFAULT_BACKUP_SETTINGS: SyncBackupSettings = Object.freeze({
  schemaVersion: BACKUP_SETTINGS_SCHEMA_VERSION,
  keepCount: DEFAULT_BACKUP_KEEP_COUNT,
})

/** 校验保留份数：BACKUP_KEEP_COUNT_MIN 到 BACKUP_KEEP_COUNT_MAX 的整数。 */
export function isBackupKeepCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= BACKUP_KEEP_COUNT_MIN &&
    value <= BACKUP_KEEP_COUNT_MAX
  )
}

/** 校验备份库设置；只认 schemaVersion 为 BACKUP_SETTINGS_SCHEMA_VERSION 的当前格式。 */
export function isSyncBackupSettings(value: unknown): value is SyncBackupSettings {
  return (
    hasShape(value, ['schemaVersion', 'keepCount']) &&
    value.schemaVersion === BACKUP_SETTINGS_SCHEMA_VERSION &&
    isBackupKeepCount(value.keepCount)
  )
}
