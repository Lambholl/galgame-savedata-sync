import { Capacitor, registerPlugin } from '@capacitor/core'
import { createLocalService } from './local-service-bridge'
import type { LocalServiceApi, LocalServiceNativePlugin } from './local-service-bridge'

const plugin = registerPlugin<LocalServiceNativePlugin>('LocalService')

/** 应用使用的本机服务；不在 Android 上运行时返回 unsupported-operation。 */
export const localService: LocalServiceApi = createLocalService(
  plugin,
  () => Capacitor.getPlatform() === 'android',
)
