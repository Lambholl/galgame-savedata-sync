import { Capacitor, registerPlugin } from '@capacitor/core'
import { createBackupBridge } from './backup-bridge'
import type { BackupNativePlugin } from './backup-bridge'

/** Android 本机备份的查询和设置；恢复写回走 androidSyncWrites。 */
export const androidBackups = createBackupBridge(
  registerPlugin<BackupNativePlugin>('SyncBackups'),
  () => Capacitor.getPlatform() === 'android',
)
