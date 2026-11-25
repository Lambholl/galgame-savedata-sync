import type { ReactElement, ReactNode } from 'react'
import type { ErrorDevice } from '../../protocol/contracts.ts'
import { localDeviceContext } from './local-device-context.ts'

/** LocalDeviceProvider 的参数。 */
export interface LocalDeviceProviderProps {
  /** 本机在连接里的角色：桌面端为 listener，移动端为 dialer。 */
  readonly device: ErrorDevice
  /** 在这台设备上显示的界面。 */
  readonly children: ReactNode
}

/** 向子组件提供本机的设备种类。 */
export function LocalDeviceProvider({ device, children }: LocalDeviceProviderProps): ReactElement {
  return <localDeviceContext.Provider value={device}>{children}</localDeviceContext.Provider>
}
