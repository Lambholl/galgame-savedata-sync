import type { DesktopSyncApi } from '../../../bridge/sync-bridge.ts'
import type { DesktopBackupApi } from '../../../bridge/backup-bridge.ts'
import { OperationFailure } from '@savedata-sync/shared'

/** 返回桌面的复制接口；组件只处理公开 DTO，操作失败由调用页面显示。 */
export function desktopSync(): DesktopSyncApi {
  if (!window.desktopSync) {
    throw new OperationFailure(
      'unsupported-operation',
      'Update desktop runtime resources and reopen the app.',
    )
  }
  return window.desktopSync
}
export function desktopBackups(): DesktopBackupApi {
  if (!window.desktopBackups) {
    throw new OperationFailure(
      'unsupported-operation',
      'Update desktop runtime resources and reopen the app.',
    )
  }
  return window.desktopBackups
}
