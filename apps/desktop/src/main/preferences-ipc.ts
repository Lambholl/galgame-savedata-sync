import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isAppPreferences } from '@savedata-sync/shared'
import type { AppPreferences } from '@savedata-sync/shared'
import { PREFERENCES_CHANNELS } from '../bridge/preferences-bridge.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { AppPreferencesStore } from './preferences-store.ts'

/** 读写界面偏好，校验主窗口来源；保存成功后通知调用方应用主题。退出时移除。 */
export function registerPreferencesIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  store: AppPreferencesStore,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  onChange: (preferences: AppPreferences) => void,
): () => void {
  ipc.handle(PREFERENCES_CHANNELS.read, (event, ...args: unknown[]) => {
    try {
      if (!isTrusted(event)) {
        throw new HttpOperationError('permission-denied', '此页面无法读取界面偏好。')
      }
      if (args.length) {
        throw new HttpOperationError('invalid-request', '界面偏好参数无效。')
      }
      return { status: 'success', value: store.get() }
    } catch (error) {
      return { status: 'error', error: toHttpError(error).operationError }
    }
  })
  ipc.handle(PREFERENCES_CHANNELS.save, async (event, ...args: unknown[]) => {
    try {
      if (!isTrusted(event)) {
        throw new HttpOperationError('permission-denied', '此页面无法修改界面偏好。')
      }
      const input = args[0]
      if (args.length !== 1 || !isAppPreferences(input)) {
        throw new HttpOperationError('invalid-request', '界面偏好参数无效。')
      }
      const preferences: AppPreferences = { theme: input.theme, locale: input.locale }
      await store.save(preferences)
      onChange(preferences)
      return { status: 'success', value: preferences }
    } catch (error) {
      return { status: 'error', error: toHttpError(error).operationError }
    }
  })
  return () => {
    for (const channel of Object.values(PREFERENCES_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
