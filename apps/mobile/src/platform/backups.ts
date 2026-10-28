import { Capacitor, registerPlugin } from '@capacitor/core'
import { createBackupBridge } from './backup-bridge'
import type { BackupNativePlugin } from './backup-bridge'

/** Android 本机备份查询及设置；恢复写回使用独立的原生同步写入桥。 */
export const androidBackups = createBackupBridge(
  registerPlugin<BackupNativePlugin>('SyncBackups'),
  () => Capacitor.getPlatform() === 'android',
)
