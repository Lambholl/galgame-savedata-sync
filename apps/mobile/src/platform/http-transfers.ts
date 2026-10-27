import { Capacitor, registerPlugin } from '@capacitor/core'
import { createHttpTransferBridge } from './http-transfer-bridge'
import type { AndroidTransferApi, HttpTransferNativePlugin } from './http-transfer-bridge'

/** Android 原生 HTTP/任务入口；网页预览仅返回不支持，内容不经过 JS。 */
export const androidTransfers: AndroidTransferApi = createHttpTransferBridge(
  registerPlugin<HttpTransferNativePlugin>('HttpTransfers'),
  () => Capacitor.getPlatform() === 'android',
)
