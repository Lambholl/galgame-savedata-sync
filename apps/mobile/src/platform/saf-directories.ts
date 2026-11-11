import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSafDirectoryBridge } from './saf-directory-bridge'
import type { AndroidDirectoryApi, SafNativePlugin } from './saf-directory-bridge'

const native = registerPlugin<SafNativePlugin>('SafDirectories')

/** 应用使用的本机目录接口；不在 Android 上运行时返回 unsupported-operation。 */
export const androidDirectories: AndroidDirectoryApi = createSafDirectoryBridge(
  native,
  () => Capacitor.getPlatform() === 'android',
)
