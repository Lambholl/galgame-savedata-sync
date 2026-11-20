import {
  isCatalogPush,
  isDirectoryListing,
  isIpv4Address,
  isListeningPort,
  isOpaqueId,
  isOperationError,
  isOperationResult,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  DeviceDescriptor,
  DirectoryListing,
  OperationError,
  OperationResult,
} from '@savedata-sync/shared'

/** 本机服务在局域网里的广播状态。 */
export type LocalServiceDiscovery = 'off' | 'starting' | 'advertising' | 'failed'

/** 本机服务的状态。 */
export interface LocalServiceStatus {
  /** 本机的稳定设备 ID，也是二维码和局域网广播里的设备 ID。 */
  readonly deviceId: string
  /** 保存的监听端口，下次启动时使用。 */
  readonly configuredPort: number
  /** 开关是否开着；进程被结束后到服务重新启动前，开关开着而 listener 为 null。 */
  readonly isEnabled: boolean
  /** 正在监听的端口和开始时间（Unix 毫秒）；服务停止时为 null。 */
  readonly listener: { readonly port: number; readonly startedAt: number } | null
  /** 本机的局域网 IPv4 地址，按推荐顺序排列；服务停止时为空。 */
  readonly ipv4Addresses: readonly string[]
  readonly discovery: LocalServiceDiscovery
  /** 最近一次启动失败的原因；启动成功或停止服务后为 null。 */
  readonly error: OperationError | null
  /** 控制通道连着本机的设备 ID；没有时为 null。 */
  readonly peerId: string | null
}

/** 和本机交换过目录表的设备。 */
export interface ListenerPeer {
  readonly deviceId: string
  /** 这台设备在目录表里报的名称。 */
  readonly name: string
  readonly platform: DeviceDescriptor['platform']
  /** 这台设备的控制通道是否连着本机。 */
  readonly isOpen: boolean
  /** 这台设备最近一次发来的游戏。 */
  readonly games: readonly CatalogGame[]
}

/** 本机服务的原生插件；方法与 LocalServiceApi 的同名方法对应，返回值未经校验。 */
export interface LocalServiceNativePlugin {
  status(): Promise<unknown>
  start(): Promise<unknown>
  stop(): Promise<unknown>
  randomizePort(): Promise<unknown>
  peers(): Promise<unknown>
  disconnectPeer(options: { deviceId: string }): Promise<unknown>
  peerDirectory(options: {
    deviceId: string
    rootId: string
    parentId: string | null
  }): Promise<unknown>
  catalogChanged(): Promise<unknown>
  addListener(
    event: 'serviceState' | 'libraryChanged',
    callback: () => void,
  ): Promise<{ remove(): Promise<void> }>
}

/** 本机服务：开关、端口、状态，以及连着本机的设备。除订阅外，所有方法的失败都以错误结果返回。 */
export interface LocalServiceApi {
  /** 读取服务状态。 */
  status(): Promise<OperationResult<LocalServiceStatus>>
  /** 打开开关并启动服务；已在运行时直接返回状态。 */
  start(): Promise<OperationResult<LocalServiceStatus>>
  /** 关掉开关、断开连着本机的设备并停止服务。 */
  stop(): Promise<OperationResult<LocalServiceStatus>>
  /** 换一个随机端口；服务运行时返回 busy。 */
  randomizePort(): Promise<OperationResult<LocalServiceStatus>>
  /** 列出和本机交换过目录表的设备；服务停止时为空。 */
  peers(): Promise<OperationResult<readonly ListenerPeer[]>>
  /** 断开连着本机的设备；它要重新连接才能再交换目录表。 */
  disconnectPeer(deviceId: string): Promise<OperationResult<null>>
  /** 经控制通道列出连着本机的设备上一个目录的一层。 */
  peerDirectory(
    deviceId: string,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
  /** 通知连着本机的设备：本机目录表变了。没有连接时什么也不做。 */
  catalogChanged(): Promise<OperationResult<null>>
  /** 订阅服务状态变化；返回的函数撤销订阅。 */
  onState(listener: () => void): () => void
  /** 订阅本机服务改写游戏库配置；返回的函数撤销订阅。 */
  onLibraryChanged(listener: () => void): () => void
}

const BRIDGE_ERROR: OperationError = {
  code: 'io-failure',
  message: 'The local service response is invalid or the connection failed.',
  canRetry: false,
}
const UNSUPPORTED: OperationError = {
  code: 'unsupported-operation',
  message: 'The local service is available in the Android app.',
  canRetry: false,
}
const DISCOVERY: readonly unknown[] = ['off', 'starting', 'advertising', 'failed']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验原生返回的服务状态。 */
export function isLocalServiceStatus(value: unknown): value is LocalServiceStatus {
  if (!record(value)) {
    return false
  }
  const listener = value.listener
  return (
    isOpaqueId(value.deviceId) &&
    isListeningPort(value.configuredPort) &&
    typeof value.isEnabled === 'boolean' &&
    (listener === null ||
      (record(listener) &&
        isListeningPort(listener.port) &&
        Number.isSafeInteger(listener.startedAt))) &&
    Array.isArray(value.ipv4Addresses) &&
    value.ipv4Addresses.length <= 8 &&
    value.ipv4Addresses.every(isIpv4Address) &&
    DISCOVERY.includes(value.discovery) &&
    (value.error === null || isOperationError(value.error)) &&
    (value.peerId === null || isOpaqueId(value.peerId))
  )
}

function isPeers(value: unknown): value is readonly ListenerPeer[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (item) =>
        record(item) &&
        isOpaqueId(item.deviceId) &&
        typeof item.name === 'string' &&
        item.name.trim() !== '' &&
        (item.platform === 'windows' || item.platform === 'android') &&
        typeof item.isOpen === 'boolean' &&
        isCatalogPush({ games: item.games, links: [] }),
    )
  )
}

function isNull(value: unknown): value is null {
  return value === null
}

/** 用原生插件创建冻结的 LocalServiceApi；isAndroid 返回 false 时方法返回 unsupported-operation，订阅不会触发。 */
export function createLocalService(
  plugin: LocalServiceNativePlugin,
  isAndroid: () => boolean,
): LocalServiceApi {
  const stateListeners = new Set<() => void>()
  const libraryListeners = new Set<() => void>()
  let isSubscribed = false
  function subscribe(): void {
    if (isSubscribed || !isAndroid()) {
      return
    }
    isSubscribed = true
    plugin
      .addListener('serviceState', () => {
        for (const listener of [...stateListeners]) {
          listener()
        }
      })
      .catch((cause: unknown) => console.error('Failed to listen for local service state', cause))
    plugin
      .addListener('libraryChanged', () => {
        for (const listener of [...libraryListeners]) {
          listener()
        }
      })
      .catch((cause: unknown) => console.error('Failed to listen for library changes', cause))
  }
  async function call<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return { status: 'error', error: UNSUPPORTED }
    }
    try {
      const result = await work()
      return isOperationResult(result, guard) ? result : { status: 'error', error: BRIDGE_ERROR }
    } catch {
      return { status: 'error', error: BRIDGE_ERROR }
    }
  }
  function invalid<T>(): OperationResult<T> {
    return {
      status: 'error',
      error: {
        code: 'invalid-request',
        message: 'The device or directory ID is invalid.',
        canRetry: false,
      },
    }
  }
  return Object.freeze({
    status: () => call(() => plugin.status(), isLocalServiceStatus),
    start: () => call(() => plugin.start(), isLocalServiceStatus),
    stop: () => call(() => plugin.stop(), isLocalServiceStatus),
    randomizePort: () => call(() => plugin.randomizePort(), isLocalServiceStatus),
    peers: () => call(() => plugin.peers(), isPeers),
    async disconnectPeer(deviceId: string): Promise<OperationResult<null>> {
      if (!isOpaqueId(deviceId)) {
        return invalid()
      }
      return call(() => plugin.disconnectPeer({ deviceId }), isNull)
    },
    async peerDirectory(
      deviceId: string,
      rootId: string,
      parentId: string | null,
    ): Promise<OperationResult<DirectoryListing>> {
      if (
        !isOpaqueId(deviceId) ||
        !isOpaqueId(rootId) ||
        (parentId !== null && !isOpaqueId(parentId))
      ) {
        return invalid()
      }
      const result = await call(
        () => plugin.peerDirectory({ deviceId, rootId, parentId }),
        isDirectoryListing,
      )
      return result.status === 'success' &&
        (result.value.rootId !== rootId || result.value.parentId !== parentId)
        ? { status: 'error', error: BRIDGE_ERROR }
        : result
    },
    catalogChanged: () => call(() => plugin.catalogChanged(), isNull),
    onState(listener: () => void): () => void {
      subscribe()
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onLibraryChanged(listener: () => void): () => void {
      subscribe()
      libraryListeners.add(listener)
      return () => libraryListeners.delete(listener)
    },
  })
}
