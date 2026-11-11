import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncTransferBridge } from './sync-transfer-bridge.ts'
import type { SyncTransferNativePlugin } from './sync-transfer-bridge.ts'

/** 应用使用的复制任务接口。 */
export const androidSyncTransfers = createSyncTransferBridge(
  registerPlugin<SyncTransferNativePlugin>('SyncTransfers'),
  () => Capacitor.getPlatform() === 'android',
)
