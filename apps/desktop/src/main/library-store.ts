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
  /** 首次没有文件时使用空库；损坏配置阻止加载，不覆盖原文件。 */
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!isLibraryConfig(value)) {
        throw new Error('游戏与设备配置格式无效。')
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
        throw new HttpOperationError('invalid-request', '游戏或设备配置无效。')
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
  /** 另一台设备已连上控制通道时拒绝新的连接，首期只连一台。 */
  private hasOtherPeer(deviceId: string): boolean {
    return [...this.runtime.keys()].some((id) => id !== deviceId && this.isOpen(id))
  }
  /** 控制通道升级前核实：设备已在本会话交换过目录表、未停用、未被本机断开。 */
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
  /** 已交换目录表的实际原生请求可续用同一连接；不会创建设备或解除显式断开。 */
  touchPeer(deviceId: string): void {
    const saved = this.config.devices.find((item) => item.id === deviceId)
    const current = this.runtime.get(deviceId)
    if (!saved || saved.blocked || !current || this.disconnected.has(deviceId)) {
      throw new HttpOperationError('session-mismatch', '设备连接已变化，请重新连接。')
    }
    if (this.hasOtherPeer(deviceId)) {
      throw new HttpOperationError('busy', '电脑已连接另一台手机，请先断开。')
    }
    this.runtime.set(deviceId, { ...current, seenAt: Date.now() })
  }
  /** 固定双向项目关联和公开根，任务写入前重核；通信超时由任务层独立处理。 */
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
      throw new HttpOperationError('session-mismatch', '项目关联或设备目录已变化，请重新确认。')
    }
  }
  async saveGames(games: readonly LibraryGame[]): Promise<void> {
    if (!isLibraryConfig({ ...this.config, games })) {
      throw new HttpOperationError('invalid-request', '游戏或设备配置无效。')
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
      throw new HttpOperationError('not-found', '请选择已登记的本机存档目录。')
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
      throw new HttpOperationError('invalid-request', '设备目录元数据无效。')
    }
    const hello = structuredClone(value)
    const saved = this.config.devices.find((item) => item.id === hello.deviceId)
    if (saved?.blocked) {
      throw new HttpOperationError('permission-denied', '此设备已停用。')
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
      throw new HttpOperationError('busy', '电脑已连接另一台手机，请先断开。')
    }
    if (!saved && this.config.devices.length >= 32) {
      throw new HttpOperationError('resource-limit', '最多保存 32 台设备。')
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
  /** 只请求已关联游戏的公开目录 ID；父目录必须来自本会话读取过的条目。 */
  directory(deviceId: string, rootId: string, parentId: string | null): Promise<DirectoryListing> {
    const peer = this.snapshot().peers.find((item) => item.device.id === deviceId)
    const runtime = this.runtime.get(deviceId)
    if (!peer?.isConnected || !peer.games.some((item) => item.root?.rootId === rootId)) {
      return Promise.reject(new HttpOperationError('not-found', '手机未在线或目录已失效。'))
    }
    if (parentId !== null && !runtime?.entries.has(`${rootId}\n${parentId}`)) {
      return Promise.reject(new HttpOperationError('invalid-request', '请从游戏根目录重新浏览。'))
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
      return Promise.reject(new HttpOperationError('not-found', '本机服务未启动。'))
    }
    const reading = control
      .request(deviceId, 'directory.list', { rootId, parentId })
      .then((value) => {
        if (value.rootId !== rootId || value.parentId !== parentId) {
          throw new HttpOperationError('invalid-request', '手机目录应答与请求不匹配。')
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
