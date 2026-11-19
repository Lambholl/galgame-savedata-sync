import {
  isIpv4Address,
  isListeningPort,
  isOpaqueId,
  isOperationResult,
  normalizeHttpAddress,
} from '@savedata-sync/shared'
import type { DeviceDescriptor, OperationResult } from '@savedata-sync/shared'

/** 局域网里搜到的一台监听方。 */
export interface DesktopNearbyDevice {
  /** TXT 记录里的设备 ID，未经连接核实。 */
  readonly deviceId: string
  readonly platform: DeviceDescriptor['platform']
  /** DNS-SD 实例名，即对方的显示名。 */
  readonly name: string
  readonly port: number
  /** 对方的 IPv4 地址，至少一个。 */
  readonly addresses: readonly string[]
}

/** 局域网搜索的状态和结果。 */
export interface DesktopNearbyState {
  /** off 表示没在搜索，searching 表示正在搜索，failed 表示无法开始搜索。 */
  readonly status: 'off' | 'searching' | 'failed'
  /** 搜到的设备，每个设备 ID 只出现一次，不含本机。 */
  readonly devices: readonly DesktopNearbyDevice[]
  /** 协议版本和本机不同的设备的实例名。 */
  readonly incompatibleNames: readonly string[]
}

/** 本机作为拨号方连着的设备。 */
export interface DesktopDialSession {
  readonly deviceId: string
  readonly platform: DeviceDescriptor['platform']
  /** 连上的 HTTP 地址，`http://` 开头。 */
  readonly address: string
  /**
   * opening：已交换目录表，控制通道还没打开过；connected：控制通道已打开；
   * reconnecting：控制通道打开过，现在断开，正在重连。
   */
  readonly state: 'connected' | 'reconnecting' | 'opening'
}

/** 拨号方的状态快照。 */
export interface DesktopDialerSnapshot {
  readonly session: DesktopDialSession | null
  readonly nearby: DesktopNearbyState
}

/** 连接成功的结果。 */
export interface DesktopDialResult {
  /** 对方在本机保存的名称。 */
  readonly name: string
  /** 连接已保存的设备、连上的不是保存的地址时为 true；用给定地址连接时总是 false。 */
  readonly isRelocated: boolean
}

/** 拨号接口：搜索附近的设备，连接其他设备。 */
export interface DesktopDialerApi {
  /** 读取状态，不续期搜索。 */
  status(): Promise<OperationResult<DesktopDialerSnapshot>>
  /** 读取状态并续期局域网搜索；没在搜索时开始搜索，停止续期 10 秒后停止。 */
  watchNearby(): Promise<OperationResult<DesktopDialerSnapshot>>
  /**
   * 依次连接 addresses 里的地址，连上一个就停。expectedDeviceId 不为 null 时，连到别的设备算失败。
   * 地址是 `IP:端口` 或 `http://IP:端口`。
   */
  connect(
    addresses: readonly string[],
    expectedDeviceId: string | null,
  ): Promise<OperationResult<DesktopDialResult>>
  /** 连接已保存的设备；保存的地址连不上时，按设备 ID 在局域网查找它的新地址再连。 */
  connectSaved(deviceId: string): Promise<OperationResult<DesktopDialResult>>
}

/** 拨号接口的 IPC 通道名。 */
export const DIALER_CHANNELS = {
  status: 'dialer:status',
  watchNearby: 'dialer:watch-nearby',
  connect: 'dialer:connect',
  connectSaved: 'dialer:connect-saved',
} as const

function isNearbyDevice(value: unknown): value is DesktopNearbyDevice {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deviceId' in value &&
    isOpaqueId(value.deviceId) &&
    'platform' in value &&
    (value.platform === 'windows' || value.platform === 'android') &&
    'name' in value &&
    typeof value.name === 'string' &&
    'port' in value &&
    isListeningPort(value.port) &&
    'addresses' in value &&
    Array.isArray(value.addresses) &&
    value.addresses.length > 0 &&
    value.addresses.every(isIpv4Address)
  )
}

function isSnapshot(value: unknown): value is DesktopDialerSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('session' in value) ||
    !('nearby' in value)
  ) {
    return false
  }
  const { session, nearby } = value
  return (
    (session === null ||
      (typeof session === 'object' &&
        'deviceId' in session &&
        isOpaqueId(session.deviceId) &&
        'platform' in session &&
        (session.platform === 'windows' || session.platform === 'android') &&
        'address' in session &&
        typeof session.address === 'string' &&
        'state' in session &&
        ['connected', 'reconnecting', 'opening'].includes(String(session.state)))) &&
    typeof nearby === 'object' &&
    nearby !== null &&
    'status' in nearby &&
    ['off', 'searching', 'failed'].includes(String(nearby.status)) &&
    'devices' in nearby &&
    Array.isArray(nearby.devices) &&
    nearby.devices.every(isNearbyDevice) &&
    'incompatibleNames' in nearby &&
    Array.isArray(nearby.incompatibleNames) &&
    nearby.incompatibleNames.every((item: unknown) => typeof item === 'string')
  )
}

function isDialResult(value: unknown): value is DesktopDialResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'isRelocated' in value &&
    typeof value.isRelocated === 'boolean'
  )
}

/**
 * 用 invoke 创建冻结的 DesktopDialerApi。
 *
 * @returns invoke 失败或返回格式不对时，对应方法返回 io-failure 错误结果。
 */
export function createDialerBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopDialerApi {
  const failure = {
    status: 'error' as const,
    error: { code: 'io-failure' as const, message: '连接状态无效，请重试。', canRetry: true },
  }
  const invalid = {
    status: 'error' as const,
    error: { code: 'invalid-request' as const, message: '地址无效。', canRetry: false },
  }
  async function call<T>(
    guard: (value: unknown) => value is T,
    channel: string,
    ...args: unknown[]
  ): Promise<OperationResult<T>> {
    try {
      const result = await invoke(channel, ...args)
      return isOperationResult(result, guard) ? result : failure
    } catch {
      return failure
    }
  }
  return Object.freeze({
    status: () => call(isSnapshot, DIALER_CHANNELS.status),
    watchNearby: () => call(isSnapshot, DIALER_CHANNELS.watchNearby),
    connect(addresses: readonly string[], expectedDeviceId: string | null) {
      let normalized: string[]
      try {
        normalized = addresses.map(normalizeHttpAddress)
      } catch {
        return Promise.resolve(invalid)
      }
      if (
        normalized.length === 0 ||
        normalized.length > 16 ||
        (expectedDeviceId !== null && !isOpaqueId(expectedDeviceId))
      ) {
        return Promise.resolve(invalid)
      }
      return call(isDialResult, DIALER_CHANNELS.connect, {
        addresses: [...new Set(normalized)],
        expectedDeviceId,
      })
    },
    connectSaved: (deviceId: string) =>
      isOpaqueId(deviceId)
        ? call(isDialResult, DIALER_CHANNELS.connectSaved, { deviceId })
        : Promise.resolve(invalid),
  })
}
