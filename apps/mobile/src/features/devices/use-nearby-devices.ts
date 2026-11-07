import { useEffect, useState } from 'react'
import { deviceDiscovery } from '../../platform/device-discovery'
import type { DeviceDiscoverySnapshot } from '../../platform/device-discovery'

/** 开始搜索后等这么久仍然没有结果，发现列表才显示“没有找到”，避免页面刚打开时闪一下。 */
const EMPTY_GRACE_MS = 3000

/** useNearbyDevices 的结果。 */
export interface NearbyDevicesState {
  readonly snapshot: DeviceDiscoverySnapshot
  /** 已搜索超过 EMPTY_GRACE_MS，可以把空列表显示为“没有找到”。 */
  readonly isSettled: boolean
  /** 搜索失败后重新开始。 */
  readonly retry: () => void
}

/**
 * 在调用它的组件挂载期间搜索局域网里的监听方设备，卸载时停止搜索。
 * 返回最新的搜索结果；Activity 在后台时原生搜索暂停，回到前台后继续。
 */
export function useNearbyDevices(): NearbyDevicesState {
  const [snapshot, setSnapshot] = useState<DeviceDiscoverySnapshot>({
    status: 'searching',
    devices: [],
    incompatibleNames: [],
  })
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [isSettled, setIsSettled] = useState(false)
  useEffect(() => deviceDiscovery.watch(setSnapshot), [])
  useEffect(() => {
    setIsSettled(false)
    const timer = setTimeout(() => setIsSettled(true), EMPTY_GRACE_MS)
    return () => clearTimeout(timer)
  }, [startedAt])
  return {
    snapshot,
    isSettled,
    retry: () => {
      deviceDiscovery.retry()
      setStartedAt(Date.now())
    },
  }
}
