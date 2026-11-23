import { OperationFailure, createPosterAdapter } from '@savedata-sync/shared'
import type { PosterAdapter, PosterApi } from '@savedata-sync/shared'

function api(): PosterApi {
  if (!window.desktopPoster) {
    throw new OperationFailure(
      'unsupported-operation',
      'Update desktop runtime resources and reopen the app.',
    )
  }
  return window.desktopPoster
}

/** 创建桌面端的封面适配器；搜索的限流排队只在同一个适配器内生效。 */
export function createDesktopPosterAdapter(): PosterAdapter {
  return createPosterAdapter(api, {
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
}
