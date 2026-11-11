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
 * 游戏库：本机游戏和已保存设备写入配置文件，对端的目录表和目录条目只在当前会话内保留。
 * 设备是否在线以控制通道是否打开为准；读取对端目录时对方 8 秒未应答即失败。
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
  /** 读取游戏库配置；文件不存在时用空库，配置损坏时抛错，原文件保留。 */
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
      /* 保存错误由持有 next 的调用方处理；这里只让队列继续，后续保存仍可重试。 */
    })
    return next
  }
  /** 设置用于通知和读取对端的控制通道；传 null 表示没有控制通道。 */
  attachControl(control: LibraryControl | null): void {
    this.control = control
  }
  private isOpen(deviceId: string): boolean {
    return this.runtime.has(deviceId) && Boolean(this.control?.isOpen(deviceId))
  }
  /** 判断是否有 deviceId 以外的设备连着控制通道。 */
  private hasOtherPeer(deviceId: string): boolean {
    return [...this.runtime.keys()].some((id) => id !== deviceId && this.isOpen(id))
  }
  /** 判断设备能否建立控制通道：本会话交换过目录表、没有停用、没有被本机断开，也没有其他设备连着。 */
  canControl(deviceId: string): boolean {
    const saved = this.config.devices.find((item) => item.id === deviceId)
    return (
      Boolean(saved && !saved.blocked) &&
      this.runtime.has(deviceId) &&
      !this.disconnected.has(deviceId) &&
      !this.hasOtherPeer(deviceId)
    )
  }
  /** 返回游戏库配置的副本，以及每台已保存设备的连接状态和游戏表。 */
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
   * 刷新设备的最近活动时间。
   *
   * @throws HttpOperationError 设备未知、已停用、没交换过目录表或已被本机断开时抛出 session-mismatch，另一台设备连着时抛出 busy。
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
        'The PC is already connected to another mobile device. Disconnect it first.',
      )
    }
    this.runtime.set(deviceId, { ...current, seenAt: Date.now() })
  }
  /** 核对项目与对端的双向关联和公开根目录，不符时抛错。 */
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
  /**
   * 用 games 替换全部本机游戏，并通知已连接的设备。
   *
   * @throws HttpOperationError 配置无效或游戏引用了未登记的根目录时抛出。
   */
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
  /** 断开、重命名或忘记一台设备；断开和忘记都会关闭控制通道，忘记还删除游戏里关联它的链接。 */
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
  /**
   * 处理对端发来的目录表：保存设备和关联，返回本机的游戏表和关联。对端告别时断开它并返回空表。
   *
   * @param isNewConnection 对端新建连接；本机断开过的设备只能这样重新交换。
   * @throws HttpOperationError 内容无效、设备已停用或已被断开、另一台设备在用或已保存的设备达到上限时抛出。
   */
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
        'The PC is already connected to another mobile device. Disconnect it first.',
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
    await this.update((current) => {
      const existing = current.devices.find((item) => item.id === hello.deviceId)
      return mergeCatalogLinks(
        {
          ...current,
          // 每次新连接把设备移到开头，已保存的设备按最近连接排序；连接期间的目录刷新不改顺序。
          devices:
            isNewConnection || !existing
              ? [
                  existing ?? {
                    id: hello.deviceId,
                    name: hello.name,
                    address: null,
                    blocked: false,
                  },
                  ...current.devices.filter((item) => item.id !== hello.deviceId),
                ]
              : current.devices,
        },
        hello.deviceId,
        hello.links.filter((link) => hello.games.some((item) => item.id === link.localGameId)),
      )
    })
    const roots = await this.adapter.listRoots()
    if (roots.status === 'error') {
      throw new HttpOperationError(roots.error.code, roots.error.message)
    }
    return {
      games: libraryCatalog(this.config, roots.value),
      links: libraryLinks(this.config, hello.deviceId),
    }
  }
  /** 读取对端一个已关联游戏目录的一层；parentId 必须来自本会话读到的条目。同一层的并发读取共用一次请求。 */
  directory(deviceId: string, rootId: string, parentId: string | null): Promise<DirectoryListing> {
    const peer = this.snapshot().peers.find((item) => item.device.id === deviceId)
    const runtime = this.runtime.get(deviceId)
    if (!peer?.isConnected || !peer.games.some((item) => item.root?.rootId === rootId)) {
      return Promise.reject(
        new HttpOperationError(
          'not-found',
          'The mobile device is offline or the directory reference expired.',
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
      // 同一层可能被连续读取多次，共用尚未应答的请求。
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
            "The mobile device's directory response does not match the request.",
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
  /** 清空会话内的对端状态和进行中的读取。 */
  stop(): void {
    this.reading.clear()
    this.runtime.clear()
    this.disconnected.clear()
  }
}
