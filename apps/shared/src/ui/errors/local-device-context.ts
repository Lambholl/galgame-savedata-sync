import { createContext, useContext } from 'react'
import type { ErrorDevice } from '../../protocol/contracts.ts'

/** 本应用运行在哪种设备上，由 LocalDeviceProvider 提供；没有提供时为 null。 */
export const localDeviceContext = createContext<ErrorDevice | null>(null)

/**
 * 取本机的设备种类。
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
