import { isAppPreferences, isOperationResult } from '@savedata-sync/shared'
import type { AppPreferences, OperationResult } from '@savedata-sync/shared'

/** 本机界面偏好接口。 */
export interface DesktopPreferencesApi {
  /** 读取界面偏好。 */
  read(): Promise<OperationResult<AppPreferences>>
  /** 保存界面偏好，并按新主题设置窗口的明暗。 */
  save(preferences: AppPreferences): Promise<OperationResult<AppPreferences>>
}

/** 界面偏好接口的 IPC 通道名。 */
export const PREFERENCES_CHANNELS = {
  read: 'preferences:read',
  save: 'preferences:save',
} as const

function invalid(): OperationResult<never> {
  return {
    status: 'error',
    error: { code: 'invalid-request', message: '界面偏好参数或响应无效。', canRetry: false },
  }
}

/**
 * 用 invoke 创建冻结的 DesktopPreferencesApi。
 *
 * @returns invoke 失败或返回格式不对时，对应方法返回 io-failure 错误结果。
 */
export function createPreferencesBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopPreferencesApi {
  async function call(
    channel: string,
    args: readonly unknown[],
  ): Promise<OperationResult<AppPreferences>> {
    try {
      const result = await invoke(channel, ...args)
      if (isOperationResult(result, isAppPreferences)) {
        return result
      }
    } catch {
      /* 无效的 IPC 返回值由外层返回统一的错误结果。 */
    }
    return invalid()
  }
  return Object.freeze({
    read: () => call(PREFERENCES_CHANNELS.read, []),
    save: (preferences: AppPreferences) =>
      isAppPreferences(preferences)
        ? call(PREFERENCES_CHANNELS.save, [
            { theme: preferences.theme, locale: preferences.locale },
          ])
        : Promise.resolve(invalid()),
  })
}
