import {
  BATCH_LIMITS,
  isOpaqueId,
  isOperationResult,
  isSyncBackupManifest,
  isSyncBackupSettings,
} from '@savedata-sync/shared'
import type { OperationResult, SyncBackupManifest, SyncBackupSettings } from '@savedata-sync/shared'

/** 列表只有轮次摘要，避免多个大清单挤占控制 JSON；详情按单轮读取。 */
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
  readonly incomplete: readonly string[]
}
export interface DesktopBackupInfo {
  readonly displayPath: string
  readonly settings: SyncBackupSettings
}
/** 本机受限入口；位置只供显示，没有创建备份、读文件字节或任意路径参数。 */
export interface DesktopBackupApi {
  read(): Promise<OperationResult<DesktopBackupInfo>>
  list(projectId: string, rootId: string): Promise<OperationResult<DesktopBackupList>>
  manifest(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<SyncBackupManifest>>
  setPreference(
    projectId: string,
    rootId: string,
    shouldBackup: boolean,
  ): Promise<OperationResult<SyncBackupSettings>>
  rotate(projectId: string, rootId: string): Promise<OperationResult<null>>
  cleanupIncomplete(
    projectId: string,
    rootId: string,
    backupId: string,
  ): Promise<OperationResult<null>>
}
export const BACKUP_CHANNELS = {
  read: 'backup:read',
  list: 'backup:list',
  manifest: 'backup:manifest',
  setPreference: 'backup:preference',
  rotate: 'backup:rotate',
  cleanupIncomplete: 'backup:cleanup-incomplete',
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
    value.incomplete.every(isOpaqueId) &&
    new Set([...value.incomplete, ...value.backups.map((item) => item.backupId)]).size ===
      value.incomplete.length + value.backups.length
  )
}
function invalid(): OperationResult<never> {
  return {
    status: 'error',
    error: { code: 'invalid-request', message: '备份参数或响应无效。', canRetry: false },
  }
}
/** 客户端校验封闭数据与项目/目录上下文；失败只返回脱敏包络。 */
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
      /* 无效 IPC 由统一错误包络报告。 */
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
    setPreference: (projectId: string, rootId: string, shouldBackup: boolean) =>
      !isOpaqueId(projectId) || !isOpaqueId(rootId) || typeof shouldBackup !== 'boolean'
        ? Promise.resolve(invalid())
        : call(
            'setPreference',
            [{ projectId, rootId, shouldBackup }],
            (value): value is SyncBackupSettings =>
              isSyncBackupSettings(value) &&
              value.projects.some(
                (item) =>
                  item.projectId === projectId &&
                  item.rootId === rootId &&
                  item.shouldBackup === shouldBackup,
              ),
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
  })
}
