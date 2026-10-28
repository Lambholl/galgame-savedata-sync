import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSyncWriteBridge } from './sync-write-bridge.ts'
import type { SyncWriteNativePlugin } from './sync-write-bridge.ts'

/** 应用原生本机恢复入口；项目配置由平台适配层核实后绑定。 */
export const androidSyncWrites = createSyncWriteBridge(
  registerPlugin<SyncWriteNativePlugin>('SyncWrites'),
  () => Capacitor.getPlatform() === 'android',
)
