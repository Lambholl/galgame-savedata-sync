import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncTransferBridge } from './sync-transfer-bridge.ts'
import type { SyncTransferNativePlugin } from './sync-transfer-bridge.ts'

/** 原生任务由应用进程持有；页面重建后先 current/query，不自动执行旧计划。 */
export const androidSyncTransfers = createSyncTransferBridge(
  registerPlugin<SyncTransferNativePlugin>('SyncTransfers'),
  () => Capacitor.getPlatform() === 'android',
)
