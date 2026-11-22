import { isOpaqueId, normalizeHttpAddress } from '@savedata-sync/shared'
import { DIALER_CHANNELS, MAX_DIAL_ADDRESSES } from '../bridge/dialer-bridge.ts'
import type { WindowsDialer } from './dialer-session.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { ChannelRegistry } from './channel-registry.ts'

/** 判断地址是否已是规范的 `http://IP:端口` 形式。 */
function isNormalizedAddress(value: unknown): value is string {
  try {
    return typeof value === 'string' && normalizeHttpAddress(value) === value
  } catch {
    // 格式不对时 normalizeHttpAddress 抛错，这里按无效地址处理。
    return false
  }
}

/**
 * 注册拨号接口的通道处理函数。
 *
 * @returns 移除这些处理函数的函数。
 */
export function registerDialerIpc(
  ipc: ChannelRegistry,
  dialer: Pick<WindowsDialer, 'status' | 'watchNearby' | 'connect' | 'connectSaved'>,
): () => void {
  for (const [action, channel] of Object.entries(DIALER_CHANNELS)) {
    ipc.handle(channel, async (...args: unknown[]) => {
      try {
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
          value.addresses.length > MAX_DIAL_ADDRESSES ||
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
