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
  OperationResult,
  PosterApi,
  PosterFileData,
  PosterHttpRequest,
  PosterImageData,
} from '@savedata-sync/shared'

/** 本机的封面执行器和封面文件接口。 */
export type DesktopPosterApi = PosterApi

/** 封面接口的 IPC 通道名。 */
export const POSTER_CHANNELS = {
  request: 'poster:request',
  downloadImage: 'poster:download-image',
  pickImage: 'poster:pick-image',
  save: 'poster:save',
  read: 'poster:read',
} as const

function invalid(): OperationResult<never> {
  return {
    status: 'error',
    error: { code: 'invalid-request', message: '封面参数或响应无效。', canRetry: false },
  }
}

function isPickedImage(value: unknown): value is PosterImageData | null {
  return value === null || isPosterImageData(value)
}

/**
 * 用 invoke 创建冻结的 DesktopPosterApi。
 *
 * @returns 参数格式不对、invoke 失败或返回格式不对时，对应方法返回 invalid-request 错误结果。
 */
export function createPosterBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopPosterApi {
  async function call<T>(
    channel: string,
    args: readonly unknown[],
    isValue: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    try {
      const result = await invoke(channel, ...args)
      if (isOperationResult(result, isValue)) {
        return result
      }
    } catch {
      /* 无效的 IPC 返回值由外层返回统一的错误结果。 */
    }
    return invalid()
  }
  return Object.freeze({
    request: (request: PosterHttpRequest) =>
      isPosterHttpRequest(request)
        ? call(
            POSTER_CHANNELS.request,
            [
              {
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: request.body,
              },
            ],
            isPosterHttpResponse,
          )
        : Promise.resolve(invalid()),
    downloadImage: (url: string) =>
      typeof url === 'string' && isPosterImageUrl(url)
        ? call(POSTER_CHANNELS.downloadImage, [url], isPosterImageData)
        : Promise.resolve(invalid()),
    pickImage: () => call(POSTER_CHANNELS.pickImage, [], isPickedImage),
    save: (gameId: string, data: PosterFileData) =>
      isOpaqueId(gameId) && isPosterFileData(data)
        ? call(POSTER_CHANNELS.save, [gameId, { data: data.data }], isPosterSaveResult)
        : Promise.resolve(invalid()),
    read: (gameId: string, posterHash: string) =>
      isOpaqueId(gameId) && isPosterHash(posterHash)
        ? call(POSTER_CHANNELS.read, [gameId, posterHash], isPosterFileData)
        : Promise.resolve(invalid()),
  })
}
