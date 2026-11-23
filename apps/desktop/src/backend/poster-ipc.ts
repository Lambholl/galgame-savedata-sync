import {
  isOpaqueId,
  isPosterFileData,
  isPosterHash,
  isPosterHttpRequest,
} from '@savedata-sync/shared'
import { POSTER_CHANNELS } from '../bridge/poster-bridge.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { ChannelRegistry } from './channel-registry.ts'
import type { PosterHttp } from './poster-http.ts'
import { readPickedImage } from './poster-store.ts'
import type { PosterStore } from './poster-store.ts'

/**
 * 注册封面接口的通道处理函数。
 *
 * @param chooseImageFile 打开选图对话框，返回选中文件的绝对路径，取消时返回 null。
 * @returns 移除这些处理函数的函数。
 */
export function registerPosterIpc(
  ipc: ChannelRegistry,
  http: PosterHttp,
  store: PosterStore,
  chooseImageFile: () => Promise<string | null>,
): () => void {
  const handle = (
    channel: string,
    isValid: (args: readonly unknown[]) => boolean,
    run: (args: readonly unknown[]) => Promise<unknown>,
  ): void => {
    ipc.handle(channel, async (...args: unknown[]) => {
      try {
        if (!isValid(args)) {
          throw new HttpOperationError('invalid-request', 'Poster parameters are invalid.')
        }
        return { status: 'success', value: await run(args) }
      } catch (error) {
        return { status: 'error', error: toHttpError(error).operationError }
      }
    })
  }
  handle(
    POSTER_CHANNELS.request,
    (args) => args.length === 1 && isPosterHttpRequest(args[0]),
    (args) => http.request(args[0] as Parameters<PosterHttp['request']>[0]),
  )
  handle(
    POSTER_CHANNELS.downloadImage,
    (args) => args.length === 1 && typeof args[0] === 'string',
    (args) => http.downloadImage(args[0] as string),
  )
  handle(
    POSTER_CHANNELS.pickImage,
    (args) => args.length === 0,
    async () => {
      const path = await chooseImageFile()
      return path === null ? null : await readPickedImage(path)
    },
  )
  handle(
    POSTER_CHANNELS.save,
    (args) => args.length === 2 && isOpaqueId(args[0]) && isPosterFileData(args[1]),
    async (args) => ({
      posterHash: await store.save(args[0] as string, (args[1] as { data: string }).data),
    }),
  )
  handle(
    POSTER_CHANNELS.read,
    (args) => args.length === 2 && isOpaqueId(args[0]) && isPosterHash(args[1]),
    async (args) => ({ data: await store.read(args[0] as string, args[1] as string) }),
  )
  return () => {
    for (const channel of Object.values(POSTER_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
