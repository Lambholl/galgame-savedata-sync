import { isOpaqueId } from '../protocol/protocol.ts'
import { hasShape, isArrayOf } from '../validation/data-validation.ts'
import type {
  SyncBackupPolicy,
  SyncBackupPreference,
  SyncBackupSettings,
} from './sync-contracts.ts'

/** 每个游戏目录保留写入前备份份数的下限。 */
export const BACKUP_KEEP_COUNT_MIN = 1
/** 每个游戏目录保留写入前备份份数的上限。 */
export const BACKUP_KEEP_COUNT_MAX = 10
/** 每个游戏目录默认保留的写入前备份份数。 */
export const DEFAULT_BACKUP_KEEP_COUNT = 3
/** 最多可以单独设置备份策略的游戏目录数。 */
export const BACKUP_PREFERENCE_LIMIT = 128

/** 没有设置文件时的全局设置：开启，保留 3 份。 */
export const DEFAULT_BACKUP_POLICY: SyncBackupPolicy = Object.freeze({
  shouldBackup: true,
  keepCount: DEFAULT_BACKUP_KEEP_COUNT,
})

/** 只有全局默认策略、没有单独设置的备份设置。 */
export const EMPTY_BACKUP_SETTINGS: SyncBackupSettings = Object.freeze({
  schemaVersion: 2,
  defaults: DEFAULT_BACKUP_POLICY,
  projects: Object.freeze([]),
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

/** 校验备份策略。 */
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

/** 校验 v2 格式的备份设置。 */
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

/** 取某个游戏目录实际使用的策略：有单独设置时用单独设置，否则用全局设置。 */
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

/**
 * 设置某个游戏目录的单独策略；policy 为 null 时改回跟随全局。
 *
 * @returns 新的备份设置，settings 本身不变。
 */
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

/**
 * 删除一个游戏所有目录的单独设置。
 *
 * @returns 新的备份设置，settings 本身不变。
 */
export function withoutGameBackups(
  settings: SyncBackupSettings,
  projectId: string,
): SyncBackupSettings {
  return {
    schemaVersion: 2,
    defaults: settings.defaults,
    projects: settings.projects.filter((item) => item.projectId !== projectId),
  }
}

/**
 * 修改全局设置，单独设置的游戏目录保持原样。
 *
 * @returns 新的备份设置，settings 本身不变。
 */
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
