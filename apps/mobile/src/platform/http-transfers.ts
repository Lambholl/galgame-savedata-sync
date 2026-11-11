import { Capacitor, registerPlugin } from '@capacitor/core'
import { createControlChannel } from './control-channel'
import type { AndroidControlApi } from './control-channel'
import { createHttpTransferBridge } from './http-transfer-bridge'
import type { AndroidTransferApi, HttpTransferNativePlugin } from './http-transfer-bridge'

const plugin = registerPlugin<HttpTransferNativePlugin>('HttpTransfers')
const isAndroid = (): boolean => Capacitor.getPlatform() === 'android'

/** 应用使用的设备连接和批量传输接口；不在 Android 上运行时返回 unsupported-operation。 */
export const androidTransfers: AndroidTransferApi = createHttpTransferBridge(plugin, isAndroid)
/** 应用使用的控制通道；不在 Android 上运行时没有连接。 */
export const androidControl: AndroidControlApi = createControlChannel(plugin, isAndroid)
