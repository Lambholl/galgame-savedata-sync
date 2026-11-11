import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncWriteBridge } from './sync-write-bridge.ts'
import type { SyncWriteNativePlugin } from './sync-write-bridge.ts'

/** 应用使用的本机恢复接口。 */
export const androidSyncWrites = createSyncWriteBridge(
  registerPlugin<SyncWriteNativePlugin>('SyncWrites'),
  () => Capacitor.getPlatform() === 'android',
)
