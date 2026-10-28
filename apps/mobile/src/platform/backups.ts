import { Capacitor, registerPlugin } from '@capacitor/core'
import { createBackupBridge } from './backup-bridge'
import type { BackupNativePlugin } from './backup-bridge'

/** Android 本机备份查询及设置；恢复写回由后续原生模块接入。 */
export const androidBackups = createBackupBridge(
  registerPlugin<BackupNativePlugin>('SyncBackups'),
  () => Capacitor.getPlatform() === 'android',
)
