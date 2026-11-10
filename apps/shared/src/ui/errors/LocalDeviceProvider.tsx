import type { ReactElement, ReactNode } from 'react'
import type { ErrorDevice } from '../../protocol/contracts.ts'
import { localDeviceContext } from './local-device-context.ts'

/** LocalDeviceProvider 的参数。 */
export interface LocalDeviceProviderProps {
  /** 本应用运行在哪种设备上：电脑端为 pc，移动端为 phone。 */
  readonly device: ErrorDevice
  /** 在这台设备上显示的界面。 */
  readonly children: ReactNode
}

/** 告诉其下的共用组件本机是哪种设备，ErrorText 据此把错误所在的一端写成“本机”或“对方设备”。 */
export function LocalDeviceProvider({ device, children }: LocalDeviceProviderProps): ReactElement {
  return <localDeviceContext.Provider value={device}>{children}</localDeviceContext.Provider>
}
