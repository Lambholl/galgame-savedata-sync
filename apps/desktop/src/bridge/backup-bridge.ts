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

/** 备份列表的一行，只含这一轮的摘要；详情按单轮读取，避免多份大清单占满控制 JSON。 */
export interface DesktopBackupSummary {
  readonly backupId: string
  readonly projectId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: 'copy' | 'restore'
  readonly fileCount: number
  readonly totalFileBytes: number
}
export interface DesktopBackupList {
  readonly backups: readonly DesktopBackupSummary[]
  readonly incomplete: readonly SyncIncompleteBackup[]
}
export interface DesktopBackupInfo {
  readonly displayPath: string
  readonly settings: SyncBackupSettings
}
/** 渲染进程使用的本机备份接口。备份位置只供显示；创建备份和读取文件内容都在主进程。 */
export interface DesktopBackupApi {
  read(): Promise<OperationResult<DesktopBackupInfo>>
  list(projectId: string, rootId: string): Promise<OperationResult<DesktopBackupList>>
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
  /** 在系统文件管理器里打开备份文件夹；路径由主进程决定。 */
  openFolder(): Promise<OperationResult<null>>
}
export const BACKUP_CHANNELS = {
  read: 'backup:read',
  list: 'backup:list',
  manifest: 'backup:manifest',
  setPreference: 'backup:preference',
  setDefaults: 'backup:defaults',
  rotate: 'backup:rotate',
  cleanupIncomplete: 'backup:cleanup-incomplete',
  deleteBackup: 'backup:delete',
  deleteGameBackups: 'backup:delete-game',
  openFolder: 'backup:open-folder',
} as const
function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function isSummary(value: unknown): value is DesktopBackupSummary {
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
    value.fileCount > 0 &&
    value.fileCount <= BATCH_LIMITS.maxFiles &&
    typeof value.totalFileBytes === 'number' &&
    Number.isSafeInteger(value.totalFileBytes) &&
    value.totalFileBytes >= 0 &&
    value.totalFileBytes <= BATCH_LIMITS.maxTotalFileBytes
  )
}
function isListing(value: unknown): value is DesktopBackupList {
  return (
    shape(value, ['backups', 'incomplete']) &&
    Array.isArray(value.backups) &&
    value.backups.every(isSummary) &&
    new Set(value.backups.map((item) => item.backupId)).size === value.backups.length &&
    Array.isArray(value.incomplete) &&
    value.incomplete.every(isSyncIncompleteBackup) &&
    new Set([
      ...value.incomplete.map((item) => item.backupId),
      ...value.backups.map((item) => item.backupId),
    ]).size ===
      value.incomplete.length + value.backups.length
  )
}
function invalid(): OperationResult<never> {
  return {
    status: 'error',
    error: { code: 'invalid-request', message: '备份参数或响应无效。', canRetry: false },
  }
}
/** 创建备份桥：校验 IPC 返回的数据及其项目和目录，失败时只返回脱敏后的错误结果。 */
export function createBackupBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopBackupApi {
  async function call<T>(
    action: keyof typeof BACKUP_CHANNELS,
    args: readonly unknown[],
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    try {
      const result = await invoke(BACKUP_CHANNELS[action], ...args)
      if (isOperationResult(result, guard)) {
        return result
      }
    } catch {
      /* 无效的 IPC 返回值由外层返回统一的错误结果。 */
    }
    return invalid()
  }
  return Object.freeze({
    read: () =>
      call(
        'read',
        [],
        (value): value is DesktopBackupInfo =>
          shape(value, ['displayPath', 'settings']) &&
          typeof value.displayPath === 'string' &&
          value.displayPath.length > 0 &&
          isSyncBackupSettings(value.settings),
      ),
    list: (projectId: string, rootId: string) =>
      !isOpaqueId(projectId) || !isOpaqueId(rootId)
        ? Promise.resolve(invalid())
        : call(
            'list',
            [{ projectId, rootId }],
            (value): value is DesktopBackupList =>
              isListing(value) &&
              value.backups.every((item) => item.projectId === projectId && item.rootId === rootId),
          ),
    manifest: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid())
        : call(
            'manifest',
            [{ projectId, rootId, backupId }],
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
        ? Promise.resolve(invalid())
        : call(
            'setPreference',
            [{ projectId, rootId, policy }],
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
        ? Promise.resolve(invalid())
        : call(
            'setDefaults',
            [{ policy }],
            (value): value is SyncBackupSettings =>
              isSyncBackupSettings(value) &&
              value.defaults.shouldBackup === policy.shouldBackup &&
              value.defaults.keepCount === policy.keepCount,
          ),
    rotate: (projectId: string, rootId: string) =>
      !isOpaqueId(projectId) || !isOpaqueId(rootId)
        ? Promise.resolve(invalid())
        : call('rotate', [{ projectId, rootId }], (value): value is null => value === null),
    cleanupIncomplete: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid())
        : call(
            'cleanupIncomplete',
            [{ projectId, rootId, backupId }],
            (value): value is null => value === null,
          ),
    deleteBackup: (projectId: string, rootId: string, backupId: string) =>
      ![projectId, rootId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid())
        : call(
            'deleteBackup',
            [{ projectId, rootId, backupId }],
            (value): value is null => value === null,
          ),
    deleteGameBackups: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(invalid())
        : call('deleteGameBackups', [{ projectId }], (value): value is null => value === null),
    openFolder: () => call('openFolder', [], (value): value is null => value === null),
  })
}
