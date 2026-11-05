import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  emptyLibrary,
  isCatalogHello,
  isLibraryConfig,
  isOpaqueId,
  libraryCatalog,
  libraryLinks,
  mergeCatalogLinks,
} from '@savedata-sync/shared'
import type {
  CatalogHello,
  CatalogReply,
  DirectoryListing,
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { ControlHub } from './control-hub.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { HttpOperationError } from './http-errors.ts'

interface PeerRuntime {
  readonly hello: CatalogHello
  readonly seenAt: number
  readonly entries: Set<string>
}
type LibraryControl = Pick<ControlHub, 'isOpen' | 'request' | 'broadcast' | 'disconnect'>
/**
 * 本机目录映射落盘；远端目录条目仅在会话内保留。
 * 设备在线以控制通道为准；目录读取经控制通道请求，对方 8 秒未应答即失败。
 */
export class DesktopLibrary {
  private config: LibraryConfig = emptyLibrary()
  private readonly runtime = new Map<string, PeerRuntime>()
  private readonly reading = new Map<string, Promise<DirectoryListing>>()
  private readonly disconnected = new Set<string>()
  private control: LibraryControl | null = null
  private saving: Promise<void> = Promise.resolve()
  constructor(
    private readonly file: string,
    private readonly adapter: WindowsDirectoryAdapter,
  ) {}
  /** 读取游戏库配置。第一次没有文件时用空库；配置损坏时加载失败，原文件保留。 */
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!isLibraryConfig(value)) {
        throw new Error('The game and device configuration format is invalid.')
      }
      this.config = value
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  private update(work: (current: LibraryConfig) => LibraryConfig): Promise<void> {
    const next = this.saving.then(async () => {
      const config = work(this.config)
      if (!isLibraryConfig(config)) {
        throw new HttpOperationError(
          'invalid-request',
          'The game or device configuration is invalid.',
        )
      }
      if (JSON.stringify(config) === JSON.stringify(this.config)) {
        return
      }
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(config), { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.file)
      this.config = config
    })
    this.saving = next.catch(() => {
      /* 调用方持有 next 并显示保存错误；后续保存仍可重试。 */
    })
    return next
  }
  /** 服务启动时接入控制通道，停止时传 null。 */
  attachControl(control: LibraryControl | null): void {
    this.control = control
  }
  private isOpen(deviceId: string): boolean {
    return this.runtime.has(deviceId) && Boolean(this.control?.isOpen(deviceId))
  }
  /** 是否已有另一台设备连着控制通道；有就拒绝新的连接，目前只连一台。 */
  private hasOtherPeer(deviceId: string): boolean {
    return [...this.runtime.keys()].some((id) => id !== deviceId && this.isOpen(id))
  }
  /** 控制通道升级前核实：设备已在本会话交换过目录表、未停用、未被本机断开，也没有另一台设备连着。 */
  canControl(deviceId: string): boolean {
    const saved = this.config.devices.find((item) => item.id === deviceId)
    return (
      Boolean(saved && !saved.blocked) &&
      this.runtime.has(deviceId) &&
      !this.disconnected.has(deviceId) &&
      !this.hasOtherPeer(deviceId)
    )
  }
  snapshot(): { readonly config: LibraryConfig; readonly peers: readonly LibraryPeer[] } {
    return {
      config: structuredClone(this.config),
      peers: this.config.devices.map((device) => ({
        device,
        isConnected: this.isOpen(device.id),
        games: this.runtime.get(device.id)?.hello.games ?? [],
      })),
    }
  }
  /**
   * 设备发来实际请求时刷新 seenAt。设备未知、已停用、没交换过目录表或已被本机断开时报 session-mismatch，
   * 另一台设备连着时报 busy。
   */
  touchPeer(deviceId: string): void {
    const saved = this.config.devices.find((item) => item.id === deviceId)
    const current = this.runtime.get(deviceId)
    if (!saved || saved.blocked || !current || this.disconnected.has(deviceId)) {
      throw new HttpOperationError(
        'session-mismatch',
        'The device connection changed. Reconnect the device.',
      )
    }
    if (this.hasOtherPeer(deviceId)) {
      throw new HttpOperationError(
        'busy',
        'The PC is already connected to another phone. Disconnect it first.',
      )
    }
    this.runtime.set(deviceId, { ...current, seenAt: Date.now() })
  }
  /** 核对项目的双向关联和公开根，任务写入前调用；通信超时由任务层处理。 */
  verifyProjectPeer(
    projectId: string,
    peerId: string,
    remoteProjectId: string,
    localRootId: string,
    remoteRootId: string,
  ): void {
    const game = this.config.games.find((item) => item.id === projectId)
    const device = this.config.devices.find((item) => item.id === peerId)
    const hello = this.runtime.get(peerId)?.hello
    const remote = hello?.games.find((item) => item.id === remoteProjectId)
    if (
      !game ||
      game.rootId !== localRootId ||
      !device ||
      device.blocked ||
      this.disconnected.has(peerId) ||
      game.excludedDevices?.includes(peerId) ||
      !game.links.some((link) => link.deviceId === peerId && link.gameId === remoteProjectId) ||
      !hello?.links.some(
        (link) => link.localGameId === remoteProjectId && link.remoteGameId === projectId,
      ) ||
      remote?.root?.rootId !== remoteRootId ||
      remote.root.deviceId !== peerId ||
      remote.root.authorization !== 'granted'
    ) {
      throw new HttpOperationError(
        'session-mismatch',
        'The project link or device directory changed. Confirm again.',
      )
    }
  }
  async saveGames(games: readonly LibraryGame[]): Promise<void> {
    if (!isLibraryConfig({ ...this.config, games })) {
      throw new HttpOperationError(
        'invalid-request',
        'The game or device configuration is invalid.',
      )
    }
    const roots = await this.adapter.listRoots()
    if (roots.status === 'error') {
      throw new HttpOperationError(roots.error.code, roots.error.message)
    }
    if (
      games.some(
        (game) => game.rootId !== null && !roots.value.some((root) => root.rootId === game.rootId),
      )
    ) {
      throw new HttpOperationError('not-found', 'Select a registered local save directory.')
    }
    await this.update((current) => ({ ...current, games }))
    this.control?.broadcast('catalog.changed', {})
  }
  async device(
    id: string,
    action: 'disconnect' | 'rename' | 'forget',
    name?: string,
  ): Promise<void> {
    if (action !== 'disconnect') {
      await this.update((current) => ({
        ...current,
        devices:
          action === 'forget'
            ? current.devices.filter((item) => item.id !== id)
            : current.devices.map((item) =>
                item.id === id ? { ...item, ...(name ? { name } : {}) } : item,
              ),
        games:
          action === 'forget'
            ? current.games.map((item) => ({
                ...item,
                links: item.links.filter((link) => link.deviceId !== id),
              }))
            : current.games,
      }))
    }
    // 设备名只存在本机，对方保留自己的命名，改名不通知对方。
    if (action !== 'rename') {
      this.disconnected.add(id)
      this.runtime.delete(id)
      this.control?.disconnect(id)
    }
  }
  async exchange(
    value: unknown,
    isTransferring = false,
    isNewConnection = false,
  ): Promise<CatalogReply> {
    if (
      typeof value === 'object' &&
      value !== null &&
      'goodbye' in value &&
      value.goodbye === true &&
      'deviceId' in value &&
      isOpaqueId(value.deviceId) &&
      Object.keys(value).length === 2
    ) {
      this.runtime.delete(value.deviceId)
      this.disconnected.delete(value.deviceId)
      this.control?.disconnect(value.deviceId)
      return { games: [], links: [] }
    }
    if (!isCatalogHello(value)) {
      throw new HttpOperationError('invalid-request', 'Device directory metadata is invalid.')
    }
    const hello = structuredClone(value)
    const saved = this.config.devices.find((item) => item.id === hello.deviceId)
    if (saved?.blocked) {
      throw new HttpOperationError('permission-denied', 'This device is disabled.')
    }
    if (isNewConnection) {
      this.disconnected.delete(hello.deviceId)
    } else if (this.disconnected.has(hello.deviceId)) {
      throw new HttpOperationError('session-mismatch', 'session-mismatch')
    }
    const latest = [...this.runtime.entries()].sort((a, b) => b[1].seenAt - a[1].seenAt)[0]?.[0]
    if (
      [...this.runtime.keys()].some(
        (id) => id !== hello.deviceId && ((isTransferring && id === latest) || this.isOpen(id)),
      )
    ) {
      throw new HttpOperationError(
        'busy',
        'The PC is already connected to another phone. Disconnect it first.',
      )
    }
    if (!saved && this.config.devices.length >= 32) {
      throw new HttpOperationError('resource-limit', 'At most 32 devices can be saved.')
    }
    const previous = this.runtime.get(hello.deviceId)
    this.runtime.set(hello.deviceId, {
      hello,
      seenAt: Date.now(),
      entries: previous?.entries ?? new Set(),
    })
    await this.update((current) =>
      mergeCatalogLinks(
        {
          ...current,
          devices: current.devices.some((item) => item.id === hello.deviceId)
            ? current.devices
            : [
                ...current.devices,
                { id: hello.deviceId, name: hello.name, address: null, blocked: false },
              ],
        },
        hello.deviceId,
        hello.links.filter((link) => hello.games.some((item) => item.id === link.localGameId)),
      ),
    )
    const roots = await this.adapter.listRoots()
    if (roots.status === 'error') {
      throw new HttpOperationError(roots.error.code, roots.error.message)
    }
    return {
      games: libraryCatalog(this.config, roots.value),
      links: libraryLinks(this.config, hello.deviceId),
    }
  }
  /** 读取已关联游戏的对方目录，只能用公开 ID；父目录必须来自本会话读取过的条目。 */
  directory(deviceId: string, rootId: string, parentId: string | null): Promise<DirectoryListing> {
    const peer = this.snapshot().peers.find((item) => item.device.id === deviceId)
    const runtime = this.runtime.get(deviceId)
    if (!peer?.isConnected || !peer.games.some((item) => item.root?.rootId === rootId)) {
      return Promise.reject(
        new HttpOperationError(
          'not-found',
          'The phone is offline or the directory reference expired.',
        ),
      )
    }
    if (parentId !== null && !runtime?.entries.has(`${rootId}\n${parentId}`)) {
      return Promise.reject(
        new HttpOperationError('invalid-request', "Browse again from the game's root directory."),
      )
    }
    const key = `${deviceId}
${rootId}
${parentId ?? ''}`
    const current = this.reading.get(key)
    if (current) {
      // 页面重新挂载会再次读取同一层，共用尚未应答的请求。
      return current
    }
    const control = this.control
    if (!control) {
      return Promise.reject(
        new HttpOperationError('not-found', 'The local service has not started.'),
      )
    }
    const reading = control
      .request(deviceId, 'directory.list', { rootId, parentId })
      .then((value) => {
        if (value.rootId !== rootId || value.parentId !== parentId) {
          throw new HttpOperationError(
            'invalid-request',
            "The phone's directory response does not match the request.",
          )
        }
        const entries = this.runtime.get(deviceId)?.entries
        for (const item of value.entries) {
          if (entries && entries.size < 32768) {
            entries.add(`${rootId}
${item.entryId}`)
          }
        }
        return value
      })
      .finally(() => this.reading.delete(key))
    this.reading.set(key, reading)
    return reading
  }
  stop(): void {
    this.reading.clear()
    this.runtime.clear()
    this.disconnected.clear()
  }
}
