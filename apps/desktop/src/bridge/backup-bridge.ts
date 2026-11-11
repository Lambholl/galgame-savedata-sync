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

/** 备份列表的一行：一份备份的摘要。 */
export interface DesktopBackupSummary {
  readonly backupId: string
  readonly projectId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: 'copy' | 'restore'
  readonly fileCount: number
  readonly totalFileBytes: number
}
/** 一个游戏目录的已提交备份和残留备份。 */
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
  /** 根据项目和目录列出本机备份。 */
  list(projectId: string, rootId: string): Promise<OperationResult<DesktopBackupList>>
  /** 读取一份备份的清单。 */
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
  /** 按保留份数删除这个游戏目录多余的旧备份；正在使用或不完整的备份保留。 */
  rotate(projectId: string, rootId: string): Promise<OperationResult<null>>
  /** 删除一份残留备份。 */
  cleanupIncomplete(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<null>>
  /** 删除一份已提交的备份。 */
  deleteBackup(projectId: string, rootId: string, backupId: string): Promise<OperationResult<null>>
  /** 删除一个游戏的全部备份和单独设置。 */
  deleteGameBackups(projectId: string): Promise<OperationResult<null>>
  /** 在系统文件管理器里打开备份文件夹。 */
  openFolder(): Promise<OperationResult<null>>
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
/**
 * 用 invoke 创建冻结的 DesktopBackupApi。
 *
 * @returns 返回值的格式、项目或目录与请求不符时，对应方法返回 io-failure 错误结果。
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
