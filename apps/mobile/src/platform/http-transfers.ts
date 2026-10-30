import { Capacitor, registerPlugin } from '@capacitor/core'
import { createControlChannel } from './control-channel'
import type { AndroidControlApi } from './control-channel'
import { createHttpTransferBridge } from './http-transfer-bridge'
import type { AndroidTransferApi, HttpTransferNativePlugin } from './http-transfer-bridge'

const plugin = registerPlugin<HttpTransferNativePlugin>('HttpTransfers')
const isAndroid = (): boolean => Capacitor.getPlatform() === 'android'

/** Android 原生 HTTP/任务入口；网页预览仅返回不支持，内容不经过 JS。 */
export const androidTransfers: AndroidTransferApi = createHttpTransferBridge(plugin, isAndroid)
/** 与已连接设备的控制通道；网页预览中没有连接。 */
export const androidControl: AndroidControlApi = createControlChannel(plugin, isAndroid)
