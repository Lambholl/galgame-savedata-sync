import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isAppPreferences } from '@savedata-sync/shared'
import type { AppPreferences } from '@savedata-sync/shared'
import { PREFERENCES_CHANNELS } from '../bridge/preferences-bridge.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { AppPreferencesStore } from './preferences-store.ts'

/**
 * 注册界面偏好接口的 IPC 处理函数；isTrusted 不通过的调用返回错误。保存成功后调用 onChange。
 *
 * @returns 移除这些处理函数的函数。
 */
export function registerPreferencesIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  store: AppPreferencesStore,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
  onChange: (preferences: AppPreferences) => void,
): () => void {
  ipc.handle(PREFERENCES_CHANNELS.read, (event, ...args: unknown[]) => {
    try {
      if (!isTrusted(event)) {
        throw new HttpOperationError(
          'permission-denied',
          'This page cannot read appearance preferences.',
        )
      }
      if (args.length) {
        throw new HttpOperationError(
          'invalid-request',
          'Appearance preference parameters are invalid.',
        )
      }
      return { status: 'success', value: store.get() }
    } catch (error) {
      return { status: 'error', error: toHttpError(error).operationError }
    }
  })
  ipc.handle(PREFERENCES_CHANNELS.save, async (event, ...args: unknown[]) => {
    try {
      if (!isTrusted(event)) {
        throw new HttpOperationError(
          'permission-denied',
          'This page cannot change appearance preferences.',
        )
      }
      const input = args[0]
      if (args.length !== 1 || !isAppPreferences(input)) {
        throw new HttpOperationError(
          'invalid-request',
          'Appearance preference parameters are invalid.',
        )
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
