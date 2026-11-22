import type { DataResetItem } from '@savedata-sync/shared'
import { DATA_RESET_CHANNELS } from '../bridge/data-reset-bridge.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { ChannelRegistry } from './channel-registry.ts'

/**
 * 注册重置项接口的通道处理函数。
 *
 * @param items 启动时改了名的数据项。
 * @param openFolder 打开原文件所在的文件夹；打不开时 reject。
 */
export function registerDataResetIpc(
  ipc: ChannelRegistry,
  items: readonly DataResetItem[],
  openFolder: () => Promise<void>,
): void {
  let pending = items
  const handle = (channel: string, work: () => Promise<unknown>): void => {
    ipc.handle(channel, async (...args: unknown[]) => {
      try {
        if (args.length) {
          throw new HttpOperationError('invalid-request', 'Data reset parameters are invalid.')
        }
        return { status: 'success', value: await work() }
      } catch (error) {
        return { status: 'error', error: toHttpError(error).operationError }
      }
    })
  }
  handle(DATA_RESET_CHANNELS.list, () => Promise.resolve(pending))
  handle(DATA_RESET_CHANNELS.dismiss, () => {
    pending = []
    return Promise.resolve(null)
  })
  handle(DATA_RESET_CHANNELS.openFolder, async () => {
    try {
      await openFolder()
    } catch (cause) {
      throw new HttpOperationError('io-failure', 'The data folder could not be opened.', cause)
    }
    return null
  })
}
