import { Capacitor, registerPlugin } from '@capacitor/core'
import { createBackupBridge } from './backup-bridge'
import type { BackupNativePlugin } from './backup-bridge'

/** 应用使用的本机备份接口。 */
export const androidBackups = createBackupBridge(
  registerPlugin<BackupNativePlugin>('SyncBackups'),
  () => Capacitor.getPlatform() === 'android',
)
