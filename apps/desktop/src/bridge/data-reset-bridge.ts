import { isDataResetList, isOperationResult } from '@savedata-sync/shared'
import type { DataResetItem, OperationResult } from '@savedata-sync/shared'

/** 启动时重置的数据项的接口。 */
export interface DesktopDataResetApi {
  /** 列出这次启动时因读不懂而改用默认值的数据项；dismiss 之后返回空列表。 */
  list(): Promise<OperationResult<readonly DataResetItem[]>>
  /** 清空重置项列表。 */
  dismiss(): Promise<OperationResult<null>>
  /** 用系统文件管理器打开改了名的原文件所在的文件夹；打不开时返回 io-failure。 */
  openFolder(): Promise<OperationResult<null>>
}

/** 重置项接口的 IPC 通道名。 */
export const DATA_RESET_CHANNELS = {
  list: 'data-reset:list',
  dismiss: 'data-reset:dismiss',
  openFolder: 'data-reset:open-folder',
} as const

function isNull(value: unknown): value is null {
  return value === null
}

/**
 * 用 invoke 创建冻结的 DesktopDataResetApi。
 *
 * @returns invoke 失败或返回格式不对时，对应方法返回 invalid-request 错误结果。
 */
export function createDataResetBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopDataResetApi {
  async function call<T>(
    channel: string,
    isValue: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    try {
      const result = await invoke(channel)
      if (isOperationResult(result, isValue)) {
        return result
      }
    } catch {
      /* 无效的 IPC 返回值由外层返回统一的错误结果。 */
    }
    return {
      status: 'error',
      error: { code: 'invalid-request', message: '重置项接口的响应无效。', canRetry: false },
    }
  }
  return Object.freeze({
    list: () => call(DATA_RESET_CHANNELS.list, isDataResetList),
    dismiss: () => call(DATA_RESET_CHANNELS.dismiss, isNull),
    openFolder: () => call(DATA_RESET_CHANNELS.openFolder, isNull),
  })
}
