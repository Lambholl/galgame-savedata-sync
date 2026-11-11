import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncScanBridge } from './sync-scan-bridge'
import type { SyncScanNativePlugin } from './sync-scan-bridge'

const native = registerPlugin<SyncScanNativePlugin>('SyncScans')

/** 应用使用的本机目录扫描接口。 */
export const androidSyncScans = createSyncScanBridge(
  native,
  () => Capacitor.getPlatform() === 'android',
)
