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

/** 向子组件提供本机的设备种类。 */
export function LocalDeviceProvider({ device, children }: LocalDeviceProviderProps): ReactElement {
  return <localDeviceContext.Provider value={device}>{children}</localDeviceContext.Provider>
}
