import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isOpaqueId, normalizeHttpAddress } from '@savedata-sync/shared'
import { DIALER_CHANNELS } from '../bridge/dialer-bridge.ts'
import type { WindowsDialer } from './dialer-session.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 判断地址是否已是规范的 `http://IP:端口` 形式。 */
function isNormalizedAddress(value: unknown): value is string {
  try {
    return typeof value === 'string' && normalizeHttpAddress(value) === value
  } catch {
    // 格式不对时 normalizeHttpAddress 抛错，这里按无效地址处理。
    return false
  }
}

/** 注册拨号接口的 IPC 处理函数；返回的函数撤销注册。 */
export function registerDialerIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  dialer: Pick<WindowsDialer, 'status' | 'watchNearby' | 'connect' | 'connectSaved'>,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  for (const [action, channel] of Object.entries(DIALER_CHANNELS)) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!isTrusted(event)) {
          throw new HttpOperationError('permission-denied', 'This page cannot connect devices.')
        }
        if (action === 'status' || action === 'watchNearby') {
          if (args.length !== 0) {
            throw new HttpOperationError('invalid-request', 'The parameters are invalid.')
          }
          return {
            status: 'success',
            value: action === 'status' ? dialer.status() : dialer.watchNearby(),
          }
        }
        const value = args[0]
        if (args.length !== 1 || typeof value !== 'object' || value === null) {
          throw new HttpOperationError('invalid-request', 'The parameters are invalid.')
        }
        if (action === 'connectSaved') {
          if (
            !('deviceId' in value) ||
            !isOpaqueId(value.deviceId) ||
            Object.keys(value).length !== 1
          ) {
            throw new HttpOperationError('invalid-request', 'The device ID is invalid.')
          }
          return { status: 'success', value: await dialer.connectSaved(value.deviceId) }
        }
        if (
          !('addresses' in value) ||
          !Array.isArray(value.addresses) ||
          value.addresses.length === 0 ||
          value.addresses.length > 16 ||
          !value.addresses.every(isNormalizedAddress) ||
          !('expectedDeviceId' in value) ||
          (value.expectedDeviceId !== null && !isOpaqueId(value.expectedDeviceId)) ||
          Object.keys(value).length !== 2
        ) {
          throw new HttpOperationError('invalid-request', 'The address is invalid.')
        }
        return {
          status: 'success',
          value: await dialer.connect(value.addresses, value.expectedDeviceId),
        }
      } catch (error) {
        return { status: 'error', error: toHttpError(error).operationError }
      }
    })
  }
  return () => {
    for (const channel of Object.values(DIALER_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
