import type { DesktopSyncApi } from '../../../bridge/sync-bridge.ts'
import type { DesktopBackupApi } from '../../../bridge/backup-bridge.ts'

/** 本端有限能力入口；组件只处理公开 DTO，操作失败由调用页面显示。 */
export function desktopSync(): DesktopSyncApi {
  if (!window.desktopSync) {
    throw new Error('请更新桌面运行资源后重新打开应用。')
  }
  return window.desktopSync
}
export function desktopBackups(): DesktopBackupApi {
  if (!window.desktopBackups) {
    throw new Error('请更新桌面运行资源后重新打开应用。')
  }
  return window.desktopBackups
}
