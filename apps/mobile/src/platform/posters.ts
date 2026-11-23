import { Capacitor, registerPlugin } from '@capacitor/core'
import { createPosterAdapter } from '@savedata-sync/shared'
import type { PosterAdapter } from '@savedata-sync/shared'
import { createPosterBridge } from './poster-bridge'
import type { PosterNativePlugin } from './poster-bridge'

const native = registerPlugin<PosterNativePlugin>('Poster')
const api = createPosterBridge(native, () => Capacitor.getPlatform() === 'android')

/** 应用的封面适配器；不在 Android 上运行时原生接口都返回 unsupported-operation，各方法随之失败。 */
export const androidPosters: PosterAdapter = createPosterAdapter(() => api, {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
