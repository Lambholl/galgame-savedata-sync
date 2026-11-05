import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncTransferBridge } from './sync-transfer-bridge.ts'
import type { SyncTransferNativePlugin } from './sync-transfer-bridge.ts'

/** 原生复制任务由应用进程持有；页面重建后先 current 或 query，之前的计划不会自动执行。 */
export const androidSyncTransfers = createSyncTransferBridge(
  registerPlugin<SyncTransferNativePlugin>('SyncTransfers'),
  () => Capacitor.getPlatform() === 'android',
)
