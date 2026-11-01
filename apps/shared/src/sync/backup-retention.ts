import { isOpaqueId } from '../protocol/protocol.ts'
import { hasShape, isArrayOf } from '../validation/data-validation.ts'
import type {
  SyncBackupPolicy,
  SyncBackupPreference,
  SyncBackupSettings,
} from './sync-contracts.ts'

/** 每个游戏、每个目录最多保留的覆盖前备份份数的范围与默认值。 */
export const BACKUP_KEEP_COUNT_MIN = 1
export const BACKUP_KEEP_COUNT_MAX = 10
export const DEFAULT_BACKUP_KEEP_COUNT = 3
/** 单独设置的游戏目录上限。 */
export const BACKUP_PREFERENCE_LIMIT = 128

/** 没有设置文件时的全局设置：开启，保留 3 份。 */
export const DEFAULT_BACKUP_POLICY: SyncBackupPolicy = Object.freeze({
  shouldBackup: true,
  keepCount: DEFAULT_BACKUP_KEEP_COUNT,
})

export const EMPTY_BACKUP_SETTINGS: SyncBackupSettings = Object.freeze({
  schemaVersion: 2,
  defaults: DEFAULT_BACKUP_POLICY,
  projects: Object.freeze([]),
})

export function isBackupKeepCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= BACKUP_KEEP_COUNT_MIN &&
    value <= BACKUP_KEEP_COUNT_MAX
  )
}

export function isSyncBackupPolicy(value: unknown): value is SyncBackupPolicy {
  return (
    hasShape(value, ['shouldBackup', 'keepCount']) &&
    typeof value.shouldBackup === 'boolean' &&
    isBackupKeepCount(value.keepCount)
  )
}

function isPreference(value: unknown): value is SyncBackupPreference {
  return (
    hasShape(value, ['projectId', 'rootId', 'shouldBackup', 'keepCount']) &&
    isOpaqueId(value.projectId) &&
    isOpaqueId(value.rootId) &&
    typeof value.shouldBackup === 'boolean' &&
    isBackupKeepCount(value.keepCount)
  )
}

/** v2 设置；坏配置不能被默认设置覆盖。 */
export function isSyncBackupSettings(value: unknown): value is SyncBackupSettings {
  return (
    hasShape(value, ['schemaVersion', 'defaults', 'projects']) &&
    value.schemaVersion === 2 &&
    isSyncBackupPolicy(value.defaults) &&
    Array.isArray(value.projects) &&
    value.projects.length <= BACKUP_PREFERENCE_LIMIT &&
    isArrayOf(value.projects, isPreference) &&
    new Set(value.projects.map((item) => JSON.stringify([item.projectId, item.rootId]))).size ===
      value.projects.length
  )
}

/** 某个游戏目录实际使用的策略；isCustom 表示单独设置，否则跟随全局。 */
export interface ResolvedBackupPolicy extends SyncBackupPolicy {
  readonly isCustom: boolean
}

export function resolveBackupPolicy(
  settings: SyncBackupSettings,
  projectId: string,
  rootId: string,
): ResolvedBackupPolicy {
  const custom = settings.projects.find(
    (item) => item.projectId === projectId && item.rootId === rootId,
  )
  const policy = custom ?? settings.defaults
  return {
    shouldBackup: policy.shouldBackup,
    keepCount: policy.keepCount,
    isCustom: Boolean(custom),
  }
}

/** 修改某个游戏目录：policy 为 null 时改回跟随全局。 */
export function withBackupPreference(
  settings: SyncBackupSettings,
  projectId: string,
  rootId: string,
  policy: SyncBackupPolicy | null,
): SyncBackupSettings {
  const others = settings.projects.filter(
    (item) => item.projectId !== projectId || item.rootId !== rootId,
  )
  return {
    schemaVersion: 2,
    defaults: settings.defaults,
    projects: policy
      ? [
          ...others,
          { projectId, rootId, shouldBackup: policy.shouldBackup, keepCount: policy.keepCount },
        ]
      : others,
  }
}

/** 修改全局设置；单独设置的游戏目录不受影响。 */
export function withBackupDefaults(
  settings: SyncBackupSettings,
  policy: SyncBackupPolicy,
): SyncBackupSettings {
  return {
    schemaVersion: 2,
    defaults: { shouldBackup: policy.shouldBackup, keepCount: policy.keepCount },
    projects: settings.projects,
  }
}
