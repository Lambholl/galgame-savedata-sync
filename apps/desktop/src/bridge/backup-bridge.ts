import {
  BATCH_LIMITS,
  isOpaqueId,
  isOperationResult,
  isSyncBackupManifest,
  isSyncBackupPolicy,
  isSyncBackupReason,
  isSyncBackupSettings,
  isSyncIncompleteBackup,
  isSyncManualBackupState,
  resolveBackupPolicy,
} from '@savedata-sync/shared'
import type {
  OperationResult,
  SyncBackupManifest,
  SyncBackupPolicy,
  SyncBackupReason,
  SyncBackupSettings,
  SyncIncompleteBackup,
  SyncManualBackupState,
} from '@savedata-sync/shared'

/** 备份列表的一行：一份备份的摘要。 */
export interface DesktopBackupSummary {
  readonly backupId: string
  readonly projectId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: SyncBackupReason
  readonly fileCount: number
  readonly totalFileBytes: number
}
/** 一个游戏的已提交备份和残留备份。 */
export interface DesktopBackupList {
  readonly backups: readonly DesktopBackupSummary[]
  readonly incomplete: readonly SyncIncompleteBackup[]
}
/** 备份位置的显示路径和备份设置。 */
export interface DesktopBackupInfo {
  readonly displayPath: string
  readonly settings: SyncBackupSettings
}
/** 本机备份接口。所有方法的失败都以错误结果返回。 */
export interface DesktopBackupApi {
  /** 读取备份位置和备份设置。 */
  read(): Promise<OperationResult<DesktopBackupInfo>>
  /** 列出这个游戏在本机所有目录下的备份。 */
  list(projectId: string): Promise<OperationResult<DesktopBackupList>>
  /** 读取一份备份的清单。 */
  manifest(projectId: string, backupId: string): Promise<OperationResult<SyncBackupManifest>>
  /** 单独设置某个游戏；policy 为 null 时改回跟随全局。 */
  setPreference(
    projectId: string,
    policy: SyncBackupPolicy | null,
  ): Promise<OperationResult<SyncBackupSettings>>
  /** 修改全局设置。 */
  setDefaults(policy: SyncBackupPolicy): Promise<OperationResult<SyncBackupSettings>>
  /** 按保留份数删除这个游戏多余的旧备份；正在使用或不完整的备份保留。 */
  rotate(projectId: string): Promise<OperationResult<null>>
  /** 删除一份残留备份。 */
  cleanupIncomplete(projectId: string, backupId: string): Promise<OperationResult<null>>
  /** 删除一份已提交的备份。 */
  deleteBackup(projectId: string, backupId: string): Promise<OperationResult<null>>
  /** 删除一个游戏的全部备份和单独设置。 */
  deleteGameBackups(projectId: string): Promise<OperationResult<null>>
  /** 在系统文件管理器里打开备份文件夹。 */
  openFolder(): Promise<OperationResult<null>>
  /** 立即为指定游戏启动一次本机手动备份。 */
  startManual(projectId: string): Promise<OperationResult<SyncManualBackupState>>
  /** 返回当前正在运行的本机手动备份状态；没有运行中的任务时返回 null。 */
  currentManual(): Promise<OperationResult<SyncManualBackupState | null>>
  /** 按 taskId 读取本机手动备份状态。 */
  manualState(taskId: string): Promise<OperationResult<SyncManualBackupState>>
  /** 取消指定的本机手动备份。 */
  cancelManual(taskId: string): Promise<OperationResult<SyncManualBackupState>>
}
/** 备份接口的 IPC 通道名。 */
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
  startManual: 'backup:manual-start',
  currentManual: 'backup:manual-current',
  manualState: 'backup:manual-state',
  cancelManual: 'backup:manual-cancel',
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
    isSyncBackupReason(value.reason) &&
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
/**
 * 用 invoke 创建冻结的 DesktopBackupApi。
 *
 * @returns 返回值的格式或游戏与请求不符时，对应方法返回 invalid-request 错误结果。
 */
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
    list: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(invalid())
        : call(
            'list',
            [{ projectId }],
            (value): value is DesktopBackupList =>
              isListing(value) && value.backups.every((item) => item.projectId === projectId),
          ),
    manifest: (projectId: string, backupId: string) =>
      ![projectId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid())
        : call(
            'manifest',
            [{ projectId, backupId }],
            (value): value is SyncBackupManifest =>
              isSyncBackupManifest(value) &&
              value.projectId === projectId &&
              value.backupId === backupId,
          ),
    setPreference: (projectId: string, policy: SyncBackupPolicy | null) =>
      !isOpaqueId(projectId) || !(policy === null || isSyncBackupPolicy(policy))
        ? Promise.resolve(invalid())
        : call('setPreference', [{ projectId, policy }], (value): value is SyncBackupSettings => {
            if (!isSyncBackupSettings(value)) {
              return false
            }
            const saved = resolveBackupPolicy(value, projectId)
            return policy
              ? saved.isCustom &&
                  saved.shouldBackup === policy.shouldBackup &&
                  saved.keepCount === policy.keepCount
              : !saved.isCustom
          }),
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
    rotate: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(invalid())
        : call('rotate', [{ projectId }], (value): value is null => value === null),
    cleanupIncomplete: (projectId: string, backupId: string) =>
      ![projectId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid())
        : call(
            'cleanupIncomplete',
            [{ projectId, backupId }],
            (value): value is null => value === null,
          ),
    deleteBackup: (projectId: string, backupId: string) =>
      ![projectId, backupId].every(isOpaqueId)
        ? Promise.resolve(invalid())
        : call('deleteBackup', [{ projectId, backupId }], (value): value is null => value === null),
    deleteGameBackups: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(invalid())
        : call('deleteGameBackups', [{ projectId }], (value): value is null => value === null),
    openFolder: () => call('openFolder', [], (value): value is null => value === null),
    startManual: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(invalid())
        : call(
            'startManual',
            [{ projectId }],
            (value): value is SyncManualBackupState =>
              isSyncManualBackupState(value) && value.projectId === projectId,
          ),
    currentManual: () =>
      call(
        'currentManual',
        [],
        (value): value is SyncManualBackupState | null =>
          value === null || isSyncManualBackupState(value),
      ),
    manualState: (taskId: string) =>
      !isOpaqueId(taskId)
        ? Promise.resolve(invalid())
        : call(
            'manualState',
            [{ taskId }],
            (value): value is SyncManualBackupState =>
              isSyncManualBackupState(value) && value.taskId === taskId,
          ),
    cancelManual: (taskId: string) =>
      !isOpaqueId(taskId)
        ? Promise.resolve(invalid())
        : call(
            'cancelManual',
            [{ taskId }],
            (value): value is SyncManualBackupState =>
              isSyncManualBackupState(value) && value.taskId === taskId,
          ),
  })
}
