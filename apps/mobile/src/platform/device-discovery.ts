import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { isIpv4Address, isListeningPort, parseDiscoveryTxt } from '@savedata-sync/shared'
import type { DeviceDescriptor } from '@savedata-sync/shared'

/** 局域网里搜到的一台监听方设备。同一设备 ID 出现在多个实例名下时合并成一项。 */
export interface DiscoveredDevice {
  /** TXT 记录里的设备 ID，未经连接核实。 */
  readonly deviceId: string
  readonly platform: DeviceDescriptor['platform']
  /** DNS-SD 实例名，即对方的显示名；局域网里重名时广播方会加序号。 */
  readonly name: string
  readonly port: number
  /** 对方的 IPv4 地址，至少一个，按系统给出的顺序。 */
  readonly addresses: readonly string[]
}

/**
 * 发现列表的当前状态。
 * searching 表示正在搜索，devices 随搜索结果变化；failed 表示系统拒绝开始搜索，可调用 retry；
 * unavailable 表示当前不是 Android 应用（浏览器预览），没有局域网搜索。
 */
export interface DeviceDiscoverySnapshot {
  readonly status: 'searching' | 'failed' | 'unavailable'
  readonly devices: readonly DiscoveredDevice[]
  /** 协议版本和本机不同的设备的实例名，发现列表可以把它们显示为需要更新。 */
  readonly incompatibleNames: readonly string[]
}

/** 局域网设备搜索。只在有订阅者时搜索，最后一个订阅者取消后停止。 */
export interface DeviceDiscoveryApi {
  /**
   * 开始搜索并订阅结果。listener 先收到一次当前结果（还没有结果时为空的 searching），之后每次变化收到完整结果。
   * 返回的函数取消订阅，重复调用没有效果。
   */
  watch(listener: (snapshot: DeviceDiscoverySnapshot) => void): () => void
  /** 搜索失败后重新开始；没有订阅者时不做任何事。 */
  retry(): void
}

/** 局域网搜索的原生插件；返回值和事件都未经校验。 */
export interface DeviceDiscoveryNativePlugin {
  start(): Promise<unknown>
  stop(): Promise<unknown>
  addListener(
    event: 'discoveryState',
    callback: (state: unknown) => void,
  ): Promise<PluginListenerHandle>
}

const SEARCHING: DeviceDiscoverySnapshot = {
  status: 'searching',
  devices: [],
  incompatibleNames: [],
}
const FAILED: DeviceDiscoverySnapshot = { status: 'failed', devices: [], incompatibleNames: [] }
const UNAVAILABLE: DeviceDiscoverySnapshot = {
  status: 'unavailable',
  devices: [],
  incompatibleNames: [],
}

interface NativeService {
  readonly name: string
  readonly port: number
  readonly addresses: readonly string[]
  readonly txt: unknown
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNativeService(value: unknown): value is NativeService {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    isListeningPort(value.port) &&
    Array.isArray(value.addresses) &&
    value.addresses.length > 0 &&
    value.addresses.every(isIpv4Address)
  )
}

/**
 * 把原生快照转成发现列表。TXT 不合法的服务被丢弃；协议版本不同的服务只留实例名。
 * 原生的 paused 和 stopped 状态都转成没有结果的 searching。
 *
 * @returns 发现列表；快照格式不对时返回 null。
 */
export function parseDiscoverySnapshot(value: unknown): DeviceDiscoverySnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.services)) {
    return null
  }
  if (value.status === 'failed') {
    return FAILED
  }
  if (value.status !== 'searching') {
    return value.status === 'paused' || value.status === 'stopped' ? SEARCHING : null
  }
  const devices = new Map<string, DiscoveredDevice>()
  const incompatibleNames: string[] = []
  for (const service of value.services.filter(isNativeService)) {
    const txt = parseDiscoveryTxt(service.txt)
    if (txt.status === 'unsupported-version') {
      incompatibleNames.push(service.name)
      continue
    }
    if (txt.status !== 'valid') {
      continue
    }
    const { deviceId, platform } = txt.identity
    const known = devices.get(deviceId)
    // 广播方重命名后旧实例名可能还没过期，同一设备会出现两次；端口相同才合并地址，端口不同时以先到的为准。
    if (known === undefined) {
      devices.set(deviceId, {
        deviceId,
        platform,
        name: service.name,
        port: service.port,
        addresses: [...new Set(service.addresses)],
      })
    } else if (known.port === service.port) {
      devices.set(deviceId, {
        ...known,
        addresses: [...new Set([...known.addresses, ...service.addresses])],
      })
    }
  }
  return { status: 'searching', devices: [...devices.values()], incompatibleNames }
}

/** 用原生插件创建 DeviceDiscoveryApi，按订阅者数量开始和停止搜索；plugin 为 null 时只回报 unavailable。 */
export function createDeviceDiscovery(
  plugin: DeviceDiscoveryNativePlugin | null,
): DeviceDiscoveryApi {
  const listeners = new Set<(snapshot: DeviceDiscoverySnapshot) => void>()
  let current = SEARCHING
  let listening: Promise<unknown> | null = null
  function publish(value: unknown): void {
    const snapshot = parseDiscoverySnapshot(value)
    if (snapshot === null || listeners.size === 0) {
      return
    }
    current = snapshot
    for (const listener of listeners) {
      listener(snapshot)
    }
  }
  function start(native: DeviceDiscoveryNativePlugin): void {
    listening ??= native.addListener('discoveryState', publish).catch((cause: unknown) => {
      console.error('Failed to listen for device discovery', cause)
    })
    native
      .start()
      .then(publish)
      .catch((cause: unknown) => {
        console.error('Failed to start device discovery', cause)
        publish({ status: 'failed', services: [] })
      })
  }
  // 网页重载后原生搜索可能还在进行而没有订阅者；Capacitor 按调用顺序执行，这次停止一定在之后的开始之前。
  plugin?.stop().catch(() => undefined)
  return {
    watch(listener) {
      if (plugin === null) {
        listener(UNAVAILABLE)
        return () => undefined
      }
      const isFirst = listeners.size === 0
      listeners.add(listener)
      if (isFirst) {
        current = SEARCHING
        start(plugin)
      }
      listener(current)
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) {
          plugin.stop().catch((cause: unknown) => {
            console.error('Failed to stop device discovery', cause)
          })
        }
      }
    },
    retry() {
      if (plugin !== null && listeners.size > 0) {
        start(plugin)
      }
    },
  }
}

/**
 * 在局域网里按设备 ID 查找一台监听方设备，查找期间订阅 discovery，结束时取消订阅。
 *
 * @returns 搜索结果里出现这个设备 ID 时 resolve 为该设备；等满 timeoutMs 仍没有、signal 中止、
 *   系统拒绝搜索或没有局域网搜索时 resolve 为 null。不会 reject。
 */
export function findDevice(
  discovery: DeviceDiscoveryApi,
  deviceId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DiscoveredDevice | null> {
  return new Promise((resolve) => {
    let stop: (() => void) | null = null
    let isDone = false
    function finish(device: DiscoveredDevice | null): void {
      if (isDone) {
        return
      }
      isDone = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      stop?.()
      resolve(device)
    }
    function abort(): void {
      finish(null)
    }
    const timer = setTimeout(abort, timeoutMs)
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort)
    stop = discovery.watch((snapshot) => {
      if (snapshot.status !== 'searching') {
        finish(null)
        return
      }
      const device = snapshot.devices.find((item) => item.deviceId === deviceId)
      if (device !== undefined) {
        finish(device)
      }
    })
    // watch 先同步回报一次当前结果，这时可能已经结束，stop 还没赋值。
    if (isDone) {
      stop()
    }
  })
}

/** 应用使用的局域网设备搜索。 */
export const deviceDiscovery = createDeviceDiscovery(
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<DeviceDiscoveryNativePlugin>('DeviceDiscovery')
    : null,
)
