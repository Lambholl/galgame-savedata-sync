import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncScanBridge } from './sync-scan-bridge'
import type { SyncScanNativePlugin } from './sync-scan-bridge'

const native = registerPlugin<SyncScanNativePlugin>('SyncScans')

/** Android 只读扫描入口，实际任务与文件流留在原生层。 */
export const androidSyncScans = createSyncScanBridge(
  native,
  () => Capacitor.getPlatform() === 'android',
)
