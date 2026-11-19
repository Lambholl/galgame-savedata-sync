import { hostname } from 'node:os'
import {
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  isBatchDeviceDescriptor,
  isCatalogReply,
  isDirectoryListing,
} from '@savedata-sync/shared'
import type {
  CatalogReply,
  ControlEventMethod,
  ControlRequestBodies,
  ControlRequestMethod,
  ControlResponseValues,
  DeviceDescriptor,
  DirectoryListing,
  OperationErrorCode,
} from '@savedata-sync/shared'
import type { DesktopDialResult, DesktopDialerSnapshot } from '../bridge/dialer-bridge.ts'
import { DialerControlSocket } from './dialer-control.ts'
import { DialerHttpClient } from './dialer-http.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { WindowsDiscoveryBrowser } from './discovery-browser.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { DesktopLibrary, LibraryDialer } from './library-store.ts'

const CATALOG_ROUTE = '/v1/catalog'
/** 读取设备信息的期限；地址不对时尽快换下一个。 */
const DEVICE_TIMEOUT_MS = 5000
/** 告别请求的期限；对方多半已经不在，不能拖住断开和退出。 */
const GOODBYE_TIMEOUT_MS = 2000
const RECONNECT_DELAY_MS = 2000
/** 控制通道异常断开后保留会话的时长。 */
const CONTROL_GRACE_MS = 10_000
/** 按设备 ID 查找新地址的时长。 */
const LOOKUP_TIMEOUT_MS = 5000
/** 这些错误说明地址上可能已经不是这台设备，可以换地址再试。 */
const RELOCATABLE_CODES: readonly OperationErrorCode[] = [
  'network-failure',
  'timeout',
  'session-mismatch',
]
const CLOSE_DISCONNECTED = 4001
const CLOSE_REPLACED = 4002

/** 拨号方用到的游戏库接口。 */
export type DialerLibrary = Pick<
  DesktopLibrary,
  'snapshot' | 'hasListenerPeer' | 'localCatalog' | 'acceptDial' | 'clearDial'
>

interface DialSession {
  readonly deviceId: string
  readonly platform: DeviceDescriptor['platform']
  /** 对方设备信息里的显示名。 */
  readonly displayName: string
  readonly http: DialerHttpClient
  readonly sessionId: string
  control: DialerControlSocket | null
  hasOpened: boolean
  /** 控制通道从什么时候起没有打开；打开时为 null。 */
  closedSince: number | null
  retryTimer: NodeJS.Timeout | null
  refreshing: Promise<void> | null
  shouldRefreshAgain: boolean
}

function busy(): HttpOperationError {
  return new HttpOperationError(
    'busy',
    'This device is connected to another device. Disconnect it first.',
  )
}

function errorCode(error: unknown): OperationErrorCode {
  return toHttpError(error).operationError.code
}

/**
 * 本机作为拨号方的连接，同一时间只连一台设备；连着时对方可以读取本机游戏的目录。
 * 控制通道异常断开时每 2 秒重连，10 秒内没恢复就断开；对方以 4001（断开）或 4002（被替换）关闭时立即断开。
 */
export class WindowsDialer implements LibraryDialer {
  private session: DialSession | null = null
  private isConnecting = false
  private readonly localName: string

  /**
   * @param displayName 交换目录表时发给对方的本机名称，默认用计算机名。
   */
  constructor(
    private readonly library: DialerLibrary,
    private readonly adapter: Pick<WindowsDirectoryAdapter, 'deviceId' | 'listDirectory'>,
    private readonly browser: Pick<WindowsDiscoveryBrowser, 'state' | 'watch' | 'find'>,
    displayName?: string,
  ) {
    this.localName = (displayName ?? hostname()).trim().slice(0, 128) || 'Windows'
  }

  /** 连接状态和附近的设备，不续期搜索。 */
  status(): DesktopDialerSnapshot {
    return { session: this.describe(), nearby: this.browser.state() }
  }

  /** 连接状态和附近的设备，并续期搜索。 */
  watchNearby(): DesktopDialerSnapshot {
    return { session: this.describe(), nearby: this.browser.watch() }
  }

  /**
   * 依次连接 origins 里的地址，连上一个就停。expectedDeviceId 不为 null 时，地址上是别的设备算失败。
   *
   * @param origins `http://IP:端口` 形式的地址。
   * @returns isRelocated 总是 false。
   * @throws HttpOperationError 已连着设备、正在连接、有设备连着本机，或所有地址都连不上时抛出；
   *   错误码取最后一个地址的错误。对方拒绝（busy、permission-denied 等）时不再试后面的地址。
   */
  async connect(
    origins: readonly string[],
    expectedDeviceId: string | null,
  ): Promise<DesktopDialResult> {
    this.begin()
    try {
      const { name } = await this.dialAll(origins, expectedDeviceId)
      return { name, isRelocated: false }
    } finally {
      this.isConnecting = false
    }
  }

  /**
   * 连接已保存的设备。附近搜到它在别的地址时先连搜到的地址；否则连保存的地址，
   * 同时按设备 ID 查找 5 秒，保存的地址连不上时再连查到的地址。
   *
   * @returns 连上的不是保存的地址时 isRelocated 为 true。
   * @throws HttpOperationError 设备没保存、已停用，或所有地址都连不上时抛出。
   */
  async connectSaved(deviceId: string): Promise<DesktopDialResult> {
    const saved = this.library.snapshot().config.devices.find((item) => item.id === deviceId)
    if (!saved) {
      throw new HttpOperationError('not-found', 'The device is not saved.')
    }
    if (saved.isBlocked) {
      throw new HttpOperationError('permission-denied', 'This device is disabled.')
    }
    this.begin()
    try {
      const { name, origin } = await this.dialSaved(deviceId, saved.address)
      return { name, isRelocated: origin !== saved.address }
    } finally {
      this.isConnecting = false
    }
  }

  private async dialSaved(
    deviceId: string,
    savedAddress: string | null,
  ): Promise<{ readonly name: string; readonly origin: string }> {
    const nearby = this.browser.state().devices.find((item) => item.deviceId === deviceId)
    const found = nearby
      ? nearby.addresses
          .map((address) => `http://${address}:${nearby.port}`)
          .filter((origin) => origin !== savedAddress)
      : []
    if (found.length > 0) {
      return await this.dialAll([...found, ...(savedAddress ? [savedAddress] : [])], deviceId)
    }
    const controller = new AbortController()
    const lookup = this.browser.find(deviceId, LOOKUP_TIMEOUT_MS, controller.signal)
    try {
      if (savedAddress === null) {
        throw new HttpOperationError('not-found', 'The device address is unknown.')
      }
      return await this.dialAll([savedAddress], deviceId)
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'not-found' && !RELOCATABLE_CODES.includes(code)) {
        throw error
      }
      const device = await lookup
      const origins =
        device?.addresses
          .map((address) => `http://${address}:${device.port}`)
          .filter((origin) => origin !== savedAddress) ?? []
      if (origins.length === 0) {
        throw error
      }
      return await this.dialAll(origins, deviceId)
    } finally {
      controller.abort()
    }
  }

  /** 连着（包括控制通道正在重连）的设备 ID；没有时为 null。 */
  deviceId(): string | null {
    return this.session?.deviceId ?? null
  }

  /** 控制通道是否打开。 */
  isOpen(): boolean {
    return Boolean(this.session?.control?.isOpen())
  }

  /**
   * 读取对方一个根目录的一层。
   *
   * @throws HttpOperationError 没连着设备、请求失败或答复格式不对时抛出。
   */
  async directory(rootId: string, parentId: string | null): Promise<DirectoryListing> {
    const session = this.session
    if (!session) {
      throw new HttpOperationError('not-found', 'The device is offline.')
    }
    const path =
      HTTP_ROUTES.entries.replace('{rootId}', encodeURIComponent(rootId)) +
      (parentId === null ? '' : `?parentId=${encodeURIComponent(parentId)}`)
    const value = await session.http.json('GET', path, {
      sessionId: session.sessionId,
      deviceId: this.adapter.deviceId,
    })
    if (!isDirectoryListing(value)) {
      throw new HttpOperationError('invalid-request', 'The device response format is invalid.')
    }
    return value
  }

  /** 断开 deviceId 并通知对方；没连着它时不做任何事。 */
  async disconnect(deviceId: string): Promise<void> {
    if (this.session?.deviceId === deviceId) {
      await this.end(this.session, true)
    }
  }

  /** 本机目录表变了；控制通道打开时重新交换目录表。 */
  catalogChanged(): void {
    if (this.session?.control?.isOpen()) {
      this.refresh(this.session)
    }
  }

  /** 断开当前连接并通知对方。 */
  async stop(): Promise<void> {
    if (this.session) {
      await this.end(this.session, true)
    }
  }

  private begin(): void {
    if (this.session || this.isConnecting || this.library.hasListenerPeer()) {
      throw busy()
    }
    this.isConnecting = true
  }

  private describe(): DesktopDialerSnapshot['session'] {
    const session = this.session
    if (!session) {
      return null
    }
    return {
      deviceId: session.deviceId,
      platform: session.platform,
      address: session.http.origin,
      state: session.control?.isOpen()
        ? 'connected'
        : session.hasOpened
          ? 'reconnecting'
          : 'opening',
    }
  }

  /** 依次连接 origins，返回对方在本机的名称和连上的地址。 */
  private async dialAll(
    origins: readonly string[],
    expectedDeviceId: string | null,
  ): Promise<{ readonly name: string; readonly origin: string }> {
    let lastError: unknown = new HttpOperationError('invalid-request', 'No address to connect.')
    for (const origin of origins) {
      try {
        return { name: await this.dial(origin, expectedDeviceId), origin }
      } catch (error) {
        lastError = error
        if (!RELOCATABLE_CODES.includes(errorCode(error))) {
          break
        }
      }
    }
    throw lastError
  }

  /** 连接 origin 并建立会话，返回对方在本机的名称。 */
  private async dial(origin: string, expectedDeviceId: string | null): Promise<string> {
    const http = new DialerHttpClient(origin)
    const info = await http.json('GET', HTTP_ROUTES.device, { timeoutMs: DEVICE_TIMEOUT_MS })
    // 先认出版本不同的对方，否则它会被当成格式错误，提示不出“版本不同”。
    if (
      typeof info === 'object' &&
      info !== null &&
      'device' in info &&
      typeof info.device === 'object' &&
      info.device !== null &&
      'protocolVersion' in info.device &&
      info.device.protocolVersion !== PROTOCOL_VERSION
    ) {
      throw new HttpOperationError('protocol-mismatch', 'The device uses another app version.')
    }
    if (!isBatchDeviceDescriptor(info)) {
      throw new HttpOperationError('invalid-request', 'The device response format is invalid.')
    }
    const peer = info.device
    const localId = this.adapter.deviceId
    if (peer.deviceId === localId) {
      throw new HttpOperationError('invalid-request', 'This address belongs to this device.')
    }
    if (expectedDeviceId !== null && peer.deviceId !== expectedDeviceId) {
      throw new HttpOperationError('session-mismatch', 'Another device is using this address.')
    }
    const reply = await this.exchange(http, info.sessionId, peer.deviceId, true)
    const goodbye = (): Promise<void> => this.goodbye(http, info.sessionId)
    // 交换目录表期间可能有设备连进本机；本机只保留一条连接，撤回这次连接。
    if (this.library.hasListenerPeer()) {
      await goodbye()
      throw busy()
    }
    let name: string
    try {
      name = await this.library.acceptDial(peer, origin, reply, true)
    } catch (error) {
      this.library.clearDial(peer.deviceId)
      await goodbye()
      throw error
    }
    const session: DialSession = {
      deviceId: peer.deviceId,
      platform: peer.platform,
      displayName: peer.displayName,
      http,
      sessionId: info.sessionId,
      control: null,
      hasOpened: false,
      closedSince: Date.now(),
      retryTimer: null,
      refreshing: null,
      shouldRefreshAgain: false,
    }
    this.session = session
    this.openControl(session)
    return name
  }

  private async exchange(
    http: DialerHttpClient,
    sessionId: string,
    peerId: string,
    isNewConnection: boolean,
  ): Promise<CatalogReply> {
    const catalog = await this.library.localCatalog(peerId)
    const reply = await http.json('POST', CATALOG_ROUTE, {
      sessionId,
      isNewConnection,
      body: {
        deviceId: this.adapter.deviceId,
        name: this.localName,
        platform: 'windows',
        ...catalog,
      },
    })
    if (
      !isCatalogReply(reply) ||
      reply.games.some((item) => item.root !== null && item.root.deviceId !== peerId)
    ) {
      throw new HttpOperationError('invalid-request', 'The device catalog is invalid.')
    }
    return reply
  }

  private async goodbye(http: DialerHttpClient, sessionId: string): Promise<void> {
    try {
      await http.json('POST', CATALOG_ROUTE, {
        sessionId,
        body: { deviceId: this.adapter.deviceId, goodbye: true },
        timeoutMs: GOODBYE_TIMEOUT_MS,
      })
    } catch {
      // 对方不在或已断开时告别会失败；对方只看到控制通道断开，按异常断开处理。
    }
  }

  private openControl(session: DialSession): void {
    session.retryTimer = null
    session.control = new DialerControlSocket(
      session.http.origin,
      session.sessionId,
      this.adapter.deviceId,
      {
        opened: () => {
          session.hasOpened = true
          session.closedSince = null
          // 断开期间两边的目录表都可能变了。
          this.refresh(session)
        },
        closed: (code) => this.controlClosed(session, code),
        event: (method) => this.receiveEvent(session, method),
        request: (method, body) => this.answer(method, body),
      },
    )
  }

  private controlClosed(session: DialSession, code: number): void {
    session.control = null
    if (this.session !== session) {
      return
    }
    if (code === CLOSE_DISCONNECTED || code === CLOSE_REPLACED) {
      this.release(session, false)
      return
    }
    session.closedSince ??= Date.now()
    if (Date.now() - session.closedSince >= CONTROL_GRACE_MS) {
      this.release(session, true)
      return
    }
    session.retryTimer = setTimeout(() => {
      if (this.session === session) {
        this.openControl(session)
      }
    }, RECONNECT_DELAY_MS)
  }

  private receiveEvent(session: DialSession, method: ControlEventMethod): void {
    if (method === 'catalog.changed') {
      this.refresh(session)
    }
  }

  private async answer<M extends ControlRequestMethod>(
    method: M,
    body: ControlRequestBodies[M],
  ): Promise<ControlResponseValues[M]> {
    if (method !== 'directory.list') {
      throw new HttpOperationError(
        'unsupported-operation',
        'This device does not support the request.',
      )
    }
    const { rootId, parentId } = body as ControlRequestBodies['directory.list']
    // 目录适配器里登记的目录不都属于游戏，只对对方开放游戏目录。
    if (!this.library.snapshot().config.games.some((item) => item.rootId === rootId)) {
      throw new HttpOperationError(
        'permission-denied',
        'The directory is not configured for a game.',
      )
    }
    const result = await this.adapter.listDirectory(rootId, parentId)
    if (result.status === 'error') {
      throw new HttpOperationError(result.error.code, result.error.message)
    }
    return result.value as ControlResponseValues[M]
  }

  /** 重新交换目录表；进行中时排到这次结束后再做一次。 */
  private refresh(session: DialSession): void {
    if (session.refreshing) {
      session.shouldRefreshAgain = true
      return
    }
    session.refreshing = (async () => {
      do {
        session.shouldRefreshAgain = false
        const reply = await this.exchange(session.http, session.sessionId, session.deviceId, false)
        if (this.session !== session) {
          return
        }
        await this.library.acceptDial(session, session.http.origin, reply, false)
      } while (session.shouldRefreshAgain && this.session === session)
    })()
      .catch((error: unknown) => {
        const code = errorCode(error)
        // 对方已把本机断开或停用：这条连接不能再用。其他错误等下次变化或重连时再交换。
        if (code === 'session-mismatch' || code === 'permission-denied') {
          this.release(session, false)
        } else {
          console.error('Failed to refresh the device catalog', toHttpError(error).operationError)
        }
      })
      .finally(() => {
        session.refreshing = null
      })
  }

  /** 结束会话，不等告别完成；失败只记日志。 */
  private release(session: DialSession, shouldSayGoodbye: boolean): void {
    this.end(session, shouldSayGoodbye).catch((error: unknown) => {
      console.error('Failed to release the device connection', toHttpError(error).operationError)
    })
  }

  private async end(session: DialSession, shouldSayGoodbye: boolean): Promise<void> {
    if (this.session !== session) {
      return
    }
    this.session = null
    if (session.retryTimer) {
      clearTimeout(session.retryTimer)
      session.retryTimer = null
    }
    session.control?.close()
    session.control = null
    this.library.clearDial(session.deviceId)
    if (shouldSayGoodbye) {
      await this.goodbye(session.http, session.sessionId)
    }
  }
}
