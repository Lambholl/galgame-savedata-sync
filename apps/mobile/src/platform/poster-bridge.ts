import {
  isOpaqueId,
  isOperationResult,
  isPosterFileData,
  isPosterHash,
  isPosterHttpRequest,
  isPosterHttpResponse,
  isPosterImageData,
  isPosterImageUrl,
  isPosterSaveResult,
} from '@savedata-sync/shared'
import type {
  OperationError,
  OperationResult,
  PosterApi,
  PosterFileData,
  PosterHttpRequest,
  PosterImageData,
} from '@savedata-sync/shared'

/** 封面的原生插件；方法与 PosterApi 的同名方法对应，返回值未经校验。 */
export interface PosterNativePlugin {
  request(options: { request: PosterHttpRequest }): Promise<unknown>
  downloadImage(options: { url: string }): Promise<unknown>
  pickImage(): Promise<unknown>
  save(options: { gameId: string; data: string }): Promise<unknown>
  read(options: { gameId: string; posterHash: string }): Promise<unknown>
}

const BRIDGE_ERROR: OperationError = {
  code: 'internal-error',
  message: 'The poster service response is invalid or the connection failed.',
  canRetry: false,
}
const UNSUPPORTED: OperationError = {
  code: 'unsupported-operation',
  message: 'Posters are available in the Android app.',
  canRetry: false,
}
const INVALID: OperationError = {
  code: 'invalid-request',
  message: 'The poster parameters are invalid.',
  canRetry: false,
}

function isPickedImage(value: unknown): value is PosterImageData | null {
  return value === null || isPosterImageData(value)
}

/**
 * 用原生插件创建冻结的 PosterApi。
 *
 * @returns 参数无效时对应方法返回 invalid-request；不在 Android 上时返回 unsupported-operation；
 *   插件调用失败或返回格式不对时返回 internal-error。
 */
export function createPosterBridge(
  plugin: PosterNativePlugin,
  isAndroid: () => boolean,
): PosterApi {
  async function call<T>(
    isValid: boolean,
    invoke: () => Promise<unknown>,
    isValue: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isValid) {
      return { status: 'error', error: INVALID }
    }
    if (!isAndroid()) {
      return { status: 'error', error: UNSUPPORTED }
    }
    try {
      const result = await invoke()
      if (isOperationResult(result, isValue)) {
        return result
      }
    } catch {
      /* 插件调用失败和无效的返回值一样，返回统一的错误结果。 */
    }
    return { status: 'error', error: BRIDGE_ERROR }
  }
  return Object.freeze({
    request: (request: PosterHttpRequest) =>
      call(
        isPosterHttpRequest(request),
        () =>
          plugin.request({
            request: {
              method: request.method,
              url: request.url,
              headers: request.headers,
              body: request.body,
            },
          }),
        isPosterHttpResponse,
      ),
    downloadImage: (url: string) =>
      call(
        typeof url === 'string' && isPosterImageUrl(url),
        () => plugin.downloadImage({ url }),
        isPosterImageData,
      ),
    pickImage: () => call(true, () => plugin.pickImage(), isPickedImage),
    save: (gameId: string, data: PosterFileData) =>
      call(
        isOpaqueId(gameId) && isPosterFileData(data),
        () => plugin.save({ gameId, data: data.data }),
        isPosterSaveResult,
      ),
    read: (gameId: string, posterHash: string) =>
      call(
        isOpaqueId(gameId) && isPosterHash(posterHash),
        () => plugin.read({ gameId, posterHash }),
        isPosterFileData,
      ),
  })
}
