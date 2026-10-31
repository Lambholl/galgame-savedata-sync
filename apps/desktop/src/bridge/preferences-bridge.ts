import { isAppPreferences, isOperationResult } from '@savedata-sync/shared'
import type { AppPreferences, OperationResult } from '@savedata-sync/shared'

/** 本机界面偏好（主题、语言）；主进程保存，并据此设置原生窗口主题。 */
export interface DesktopPreferencesApi {
  read(): Promise<OperationResult<AppPreferences>>
  save(preferences: AppPreferences): Promise<OperationResult<AppPreferences>>
}

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
      /* 无效 IPC 由统一错误包络报告。 */
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
