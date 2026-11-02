import {
  BATCH_LIMITS,
  isOpaqueId,
  isOperationResult,
  isSyncBackupManifest,
  isSyncBackupPolicy,
  isSyncBackupSettings,
  isSyncIncompleteBackup,
  resolveBackupPolicy,
} from '@savedata-sync/shared'
import type {
  OperationResult,
  SyncBackupManifest,
  SyncBackupPolicy,
  SyncBackupSettings,
  SyncIncompleteBackup,
} from '@savedata-sync/shared'

/** 本机列表只传轮次摘要，完整清单按单轮读取。 */
export interface AndroidBackupSummary {
  readonly backupId: string
  readonly projectId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: 'copy' | 'restore'
  readonly fileCount: number
  readonly totalFileBytes: number
}
export interface AndroidBackupList {
  readonly backups: readonly AndroidBackupSummary[]
  readonly incomplete: readonly SyncIncompleteBackup[]
}
export interface AndroidBackupInfo {
  readonly displayPath: string
  readonly settings: SyncBackupSettings
}
export interface BackupNativePlugin {
  read(): Promise<unknown>
  list(options: { projectId: string; rootId: string }): Promise<unknown>
  manifest(options: { projectId: string; rootId: string; backupId: string }): Promise<unknown>
  setPreference(options: {
    projectId: string
    rootId: string
    policy: SyncBackupPolicy | null
  }): Promise<unknown>
  setDefaults(options: { policy: SyncBackupPolicy }): Promise<unknown>
  rotate(options: { projectId: string; rootId: string }): Promise<unknown>
  cleanupIncomplete(options: {
    projectId: string
    rootId: string
    backupId: string
  }): Promise<unknown>
  deleteBackup(options: { projectId: string; rootId: string; backupId: string }): Promise<unknown>
  deleteGameBackups(options: { projectId: string }): Promise<unknown>
}
/** 公开参数只有 ID 与开关；创建及恢复文件流不经过网页。 */
export interface AndroidBackupApi {
  read(): Promise<OperationResult<AndroidBackupInfo>>
  list(projectId: string, rootId: string): Promise<OperationResult<AndroidBackupList>>
  manifest(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<SyncBackupManifest>>
  /** 单独设置某个游戏目录；policy 为 null 时改回跟随全局。 */
  setPreference(
    projectId: string,
    rootId: string,
    policy: SyncBackupPolicy | null,
  ): Promise<OperationResult<SyncBackupSettings>>
  /** 修改全局设置。 */
  setDefaults(policy: SyncBackupPolicy): Promise<OperationResult<SyncBackupSettings>>
  rotate(projectId: string, rootId: string): Promise<OperationResult<null>>
  cleanupIncomplete(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<null>>
  /** 删除一份已提交的备份。 */
  deleteBackup(projectId: string, rootId: string, backupId: string): Promise<OperationResult<null>>
  /** 移除游戏时删除它的全部备份和单独设置。 */
  deleteGameBackups(projectId: string): Promise<OperationResult<null>>
}
function shape(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}
function isSummary(value: unknown): value is AndroidBackupSummary {
  return (
    shape(value, [
      'backupId',
      'projectId',
      'rootId',
      'createdAt',
      'reason',
      'fileCount',
      'totalFileBytes',
    ]) &&
    [value.backupId, value.projectId, value.rootId].every(isOpaqueId) &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    Math.abs(value.createdAt) <= 8.64e15 &&
    (value.reason === 'copy' || value.reason === 'restore') &&
    typeof value.fileCount === 'number' &&
    Number.isSafeInteger(value.fileCount) &&
    value.fileCount >= 1 &&
    value.fileCount <= BATCH_LIMITS.maxFiles &&
    typeof value.totalFileBytes === 'number' &&
    Number.isSafeInteger(value.totalFileBytes) &&
    value.totalFileBytes >= 0 &&
    value.totalFileBytes <= BATCH_LIMITS.maxTotalFileBytes
  )
}
function isListing(value: unknown): value is AndroidBackupList {
  return (
    shape(value, ['backups', 'incomplete']) &&
    Array.isArray(value.backups) &&
    value.backups.every(isSummary) &&
    Array.isArray(value.incomplete) &&
    value.incomplete.every(isSyncIncompleteBackup) &&
    new Set([
      ...value.backups.map((item) => item.backupId),
      ...value.incomplete.map((item) => item.backupId),
    ]).size ===
      value.backups.length + value.incomplete.length
  )
}
function failure(
  code: 'invalid-request' | 'unsupported-operation' | 'io-failure',
): OperationResult<never> {
  return {
    status: 'error',
    error: {
      code,
      message:
        code === 'unsupported-operation'
          ? 'View backups in the Android app.'
          : 'Backup parameters or the response are invalid.',
      canRetry: false,
    },
  }
}
/** 校验原生数据与本次项目/目录/轮次，不读取页面可见性或传递平台文件路径。 */
export function createBackupBridge(
  plugin: BackupNativePlugin,
  isAndroid: () => boolean,
): AndroidBackupApi {
  async function invoke<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return failure('unsupported-operation')
    }
    try {
      const value = await work()
      return isOperationResult(value, guard) ? value : failure('io-failure')
    } catch {
      return failure('io-failure')
    }
  }
  return Object.freeze({
    read: () =>
      invoke(
        () => plugin.read(),
        (value): value is AndroidBackupInfo =>
          shape(value, ['displayPath', 'settings']) &&
          typeof value.displayPath === 'string' &&
          value.displayPath.length > 0 &&
          isSyncBackupSettings(value.settings),
      ),
    list: (projectId: string, rootId: string) =>
      !isOpaqueId(projectId) || !isOpaqueId(rootId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.list({ projectId, rootId }),
            (value): value is AndroidBackupList =>
              isListing(value) &&
              value.backups.every((item) => item.projectId === projectId && item.rootId === rootId),
          ),
    manifest: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.manifest({ projectId, rootId, backupId }),
            (value): value is SyncBackupManifest =>
              isSyncBackupManifest(value) &&
              value.projectId === projectId &&
              value.rootId === rootId &&
              value.backupId === backupId,
          ),
    setPreference: (projectId: string, rootId: string, policy: SyncBackupPolicy | null) =>
      !isOpaqueId(projectId) ||
      !isOpaqueId(rootId) ||
      !(policy === null || isSyncBackupPolicy(policy))
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.setPreference({ projectId, rootId, policy }),
            (value): value is SyncBackupSettings => {
              if (!isSyncBackupSettings(value)) {
                return false
              }
              const saved = resolveBackupPolicy(value, projectId, rootId)
              return policy
                ? saved.isCustom &&
                    saved.shouldBackup === policy.shouldBackup &&
                    saved.keepCount === policy.keepCount
                : !saved.isCustom
            },
          ),
    setDefaults: (policy: SyncBackupPolicy) =>
      !isSyncBackupPolicy(policy)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.setDefaults({ policy }),
            (value): value is SyncBackupSettings =>
              isSyncBackupSettings(value) &&
              value.defaults.shouldBackup === policy.shouldBackup &&
              value.defaults.keepCount === policy.keepCount,
          ),
    rotate: (projectId: string, rootId: string) =>
      !isOpaqueId(projectId) || !isOpaqueId(rootId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.rotate({ projectId, rootId }),
            (value): value is null => value === null,
          ),
    cleanupIncomplete: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.cleanupIncomplete({ projectId, rootId, backupId }),
            (value): value is null => value === null,
          ),
    deleteBackup: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.deleteBackup({ projectId, rootId, backupId }),
            (value): value is null => value === null,
          ),
    deleteGameBackups: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.deleteGameBackups({ projectId }),
            (value): value is null => value === null,
          ),
  })
}
