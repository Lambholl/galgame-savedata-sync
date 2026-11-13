import { Capacitor, registerPlugin } from '@capacitor/core'
import { createDirectoryBridge } from './directory-bridge'
import type { AndroidDirectoryApi, DirectoryNativePlugin } from './directory-bridge'

const native = registerPlugin<DirectoryNativePlugin>('Directories')

/** 应用使用的本机目录接口；不在 Android 上运行时返回 unsupported-operation。 */
export const androidDirectories: AndroidDirectoryApi = createDirectoryBridge(
  native,
  () => Capacitor.getPlatform() === 'android',
)
