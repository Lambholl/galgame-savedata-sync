import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSafDirectoryBridge } from './saf-directory-bridge'
import type { AndroidDirectoryApi, SafNativePlugin } from './saf-directory-bridge'

const native = registerPlugin<SafNativePlugin>('SafDirectories')

/** Android SAF 元数据入口；浏览器预览返回 unsupported-operation。 */
export const androidDirectories: AndroidDirectoryApi = createSafDirectoryBridge(
  native,
  () => Capacitor.getPlatform() === 'android',
)
