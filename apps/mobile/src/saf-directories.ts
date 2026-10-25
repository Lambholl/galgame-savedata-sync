import { Capacitor, registerPlugin } from '@capacitor/core'
import { createSafDirectoryBridge } from './saf-directory-bridge'
import type { AndroidDirectoryApi, SafNativePlugin } from './saf-directory-bridge'

const native = registerPlugin<SafNativePlugin>('SafDirectories')

/** Android SAF metadata entry point; browser preview resolves unsupported-operation. */
export const androidDirectories: AndroidDirectoryApi = createSafDirectoryBridge(
  native,
  () => Capacitor.getPlatform() === 'android',
)
