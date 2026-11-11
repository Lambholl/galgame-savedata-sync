import type { DesktopSyncApi } from '../../../bridge/sync-bridge.ts'
import type { DesktopBackupApi } from '../../../bridge/backup-bridge.ts'
import { OperationFailure } from '@savedata-sync/shared'

/** 返回桌面的复制接口；preload 没有提供时抛出 unsupported-operation 错误。 */
export function desktopSync(): DesktopSyncApi {
  if (!window.desktopSync) {
    throw new OperationFailure(
      'unsupported-operation',
      'Update desktop runtime resources and reopen the app.',
    )
  }
  return window.desktopSync
}
/** 返回桌面的备份接口；preload 没有提供时抛出 unsupported-operation 错误。 */
export function desktopBackups(): DesktopBackupApi {
  if (!window.desktopBackups) {
    throw new OperationFailure(
      'unsupported-operation',
      'Update desktop runtime resources and reopen the app.',
    )
  }
  return window.desktopBackups
}
