import { createContext, useContext } from 'react'
import type { ErrorDevice } from '../../protocol/contracts.ts'

/** 本机在连接里的角色；不在 LocalDeviceProvider 之下时为 null。 */
export const localDeviceContext = createContext<ErrorDevice | null>(null)

/**
 * 取本机在连接里的角色。
 *
 * @throws Error 组件不在 LocalDeviceProvider 之下时抛出。
 */
export function useLocalDevice(): ErrorDevice {
  const device = useContext(localDeviceContext)
  if (device === null) {
    throw new Error('useLocalDevice 需要在 LocalDeviceProvider 之下调用')
  }
  return device
}
