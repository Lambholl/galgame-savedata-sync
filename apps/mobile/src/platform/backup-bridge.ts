import {
  BATCH_LIMITS,
  isBackupKeepCount,
  isOpaqueId,
  isOperationResult,
  isSyncBackupManifest,
  isSyncBackupReason,
  isSyncBackupSettings,
  isSyncIncompleteBackup,
  isSyncManualBackupState,
} from '@savedata-sync/shared'
import type {
  OperationResult,
  SyncBackupManifest,
  SyncBackupReason,
  SyncBackupSettings,
  SyncIncompleteBackup,
  SyncManualBackupState,
} from '@savedata-sync/shared'

/** 备份列表的一行：一份备份的摘要。 */
export interface AndroidBackupSummary {
  readonly backupId: string
  readonly projectId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: SyncBackupReason
  readonly fileCount: number
  readonly totalFileBytes: number
}
/** 一个游戏的已提交备份和残留备份。 */
export interface AndroidBackupList {
  readonly backups: readonly AndroidBackupSummary[]
  readonly incomplete: readonly SyncIncompleteBackup[]
}
/** 备份位置的显示路径和备份设置。 */
export interface AndroidBackupInfo {
  readonly displayPath: string
  readonly settings: SyncBackupSettings
}
/** 备份的原生插件；方法与 AndroidBackupApi 的同名方法对应，返回值未经校验。 */
export interface BackupNativePlugin {
  read(): Promise<unknown>
  list(options: { projectId: string }): Promise<unknown>
  manifest(options: { projectId: string; backupId: string }): Promise<unknown>
  setKeepCount(options: { keepCount: number }): Promise<unknown>
  rotate(options: { projectId: string }): Promise<unknown>
  cleanupIncomplete(options: { projectId: string; backupId: string }): Promise<unknown>
  deleteBackup(options: { projectId: string; backupId: string }): Promise<unknown>
  deleteGameBackups(options: { projectId: string }): Promise<unknown>
  startManual(options: { projectId: string; rootId: string }): Promise<unknown>
  currentManual(): Promise<unknown>
  manualState(options: { taskId: string }): Promise<unknown>
  cancelManual(options: { taskId: string }): Promise<unknown>
}
/** 本机备份接口。所有方法的失败都以错误结果返回。 */
export interface AndroidBackupApi {
  /** 读取备份位置和备份设置。 */
  read(): Promise<OperationResult<AndroidBackupInfo>>
  /** 列出这个游戏在本机所有目录下的备份。 */
  list(projectId: string): Promise<OperationResult<AndroidBackupList>>
  /** 读取一份备份的清单。 */
  manifest(projectId: string, backupId: string): Promise<OperationResult<SyncBackupManifest>>
  /**
   * 修改备份库的保留份数；已有的备份到下一次轮换时才按新份数删除。
   * keepCount 不是 BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX 内的整数时返回 invalid-request。
   */
  setKeepCount(keepCount: number): Promise<OperationResult<SyncBackupSettings>>
  /** 按保留份数删除这个游戏多余的旧备份；正在使用或不完整的备份保留。 */
  rotate(projectId: string): Promise<OperationResult<null>>
  /** 删除一份残留备份。 */
  cleanupIncomplete(projectId: string, backupId: string): Promise<OperationResult<null>>
  /** 删除一份已提交的备份。 */
  deleteBackup(projectId: string, backupId: string): Promise<OperationResult<null>>
  /** 删除一个游戏的全部备份。 */
  deleteGameBackups(projectId: string): Promise<OperationResult<null>>
  /** 立即为指定游戏目录启动一次本机手动备份。 */
  startManual(projectId: string, rootId: string): Promise<OperationResult<SyncManualBackupState>>
  /** 返回当前正在运行的本机手动备份状态；没有运行中的任务时返回 null。 */
  currentManual(): Promise<OperationResult<SyncManualBackupState | null>>
  /** 按 taskId 读取本机手动备份状态。 */
  manualState(taskId: string): Promise<OperationResult<SyncManualBackupState>>
  /** 取消指定的本机手动备份。 */
  cancelManual(taskId: string): Promise<OperationResult<SyncManualBackupState>>
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
    isSyncBackupReason(value.reason) &&
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
  code: 'invalid-request' | 'unsupported-operation' | 'internal-error',
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
/**
 * 用原生插件创建 AndroidBackupApi。
 *
 * @returns 返回值的格式、游戏或备份与请求不符时，对应方法返回 internal-error 错误结果。
 */
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
      return isOperationResult(value, guard) ? value : failure('internal-error')
    } catch {
      return failure('internal-error')
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
    list: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.list({ projectId }),
            (value): value is AndroidBackupList =>
              isListing(value) && value.backups.every((item) => item.projectId === projectId),
          ),
    manifest: (projectId: string, backupId: string) =>
      ![projectId, backupId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.manifest({ projectId, backupId }),
            (value): value is SyncBackupManifest =>
              isSyncBackupManifest(value) &&
              value.projectId === projectId &&
              value.backupId === backupId,
          ),
    setKeepCount: (keepCount: number) =>
      !isBackupKeepCount(keepCount)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.setKeepCount({ keepCount }),
            (value): value is SyncBackupSettings =>
              isSyncBackupSettings(value) && value.keepCount === keepCount,
          ),
    rotate: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.rotate({ projectId }),
            (value): value is null => value === null,
          ),
    cleanupIncomplete: (projectId: string, backupId: string) =>
      ![projectId, backupId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.cleanupIncomplete({ projectId, backupId }),
            (value): value is null => value === null,
          ),
    deleteBackup: (projectId: string, backupId: string) =>
      ![projectId, backupId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.deleteBackup({ projectId, backupId }),
            (value): value is null => value === null,
          ),
    deleteGameBackups: (projectId: string) =>
      !isOpaqueId(projectId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.deleteGameBackups({ projectId }),
            (value): value is null => value === null,
          ),
    startManual: (projectId: string, rootId: string) =>
      ![projectId, rootId].every(isOpaqueId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.startManual({ projectId, rootId }),
            (value): value is SyncManualBackupState =>
              isSyncManualBackupState(value) &&
              value.projectId === projectId &&
              value.rootId === rootId,
          ),
    currentManual: () =>
      invoke(
        () => plugin.currentManual(),
        (value): value is SyncManualBackupState | null =>
          value === null || isSyncManualBackupState(value),
      ),
    manualState: (taskId: string) =>
      !isOpaqueId(taskId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.manualState({ taskId }),
            (value): value is SyncManualBackupState =>
              isSyncManualBackupState(value) && value.taskId === taskId,
          ),
    cancelManual: (taskId: string) =>
      !isOpaqueId(taskId)
        ? Promise.resolve(failure('invalid-request'))
        : invoke(
            () => plugin.cancelManual({ taskId }),
            (value): value is SyncManualBackupState =>
              isSyncManualBackupState(value) && value.taskId === taskId,
          ),
  })
}
