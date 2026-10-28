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
  DirectoryQuery,
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { HttpOperationError } from './http-errors.ts'

interface PeerRuntime {
  readonly hello: CatalogHello
  readonly seenAt: number
  readonly entries: Set<string>
}
interface PendingDirectory {
  readonly query: DirectoryQuery
  readonly resolve: (value: DirectoryListing) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}
/** 本机目录映射落盘；远端目录条目仅在会话内保留。目录查询在 8 秒未应答时失败。 */
export class DesktopLibrary {
  private config: LibraryConfig = emptyLibrary()
  private readonly runtime = new Map<string, PeerRuntime>()
  private readonly pending = new Map<string, PendingDirectory>()
  private readonly disconnected = new Set<string>()
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
  snapshot(): { readonly config: LibraryConfig; readonly peers: readonly LibraryPeer[] } {
    return {
      config: structuredClone(this.config),
      peers: this.config.devices.map((device) => ({
        device,
        isConnected: Date.now() - (this.runtime.get(device.id)?.seenAt ?? 0) < 15000,
        games: this.runtime.get(device.id)?.hello.games ?? [],
      })),
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
    if (action !== 'rename') {
      this.disconnected.add(id)
      this.runtime.delete(id)
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new HttpOperationError('network-failure', '设备已断开。'))
        this.pending.delete(id)
      }
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
      return { games: [], links: [], request: null }
    }
    if (!isCatalogHello(value)) {
      throw new HttpOperationError('invalid-request', '设备目录元数据无效。')
    }
    const hello = structuredClone(value)
    const saved = this.config.devices.find((item) => item.id === hello.deviceId)
    if (isNewConnection) {
      this.disconnected.delete(hello.deviceId)
    } else if (this.disconnected.has(hello.deviceId)) {
      throw new HttpOperationError('session-mismatch', 'session-mismatch')
    }
    if (
      [...this.runtime.entries()].some(
        ([id, item]) =>
          id !== hello.deviceId && (isTransferring || Date.now() - item.seenAt < 15000),
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
    const pending = this.pending.get(hello.deviceId)
    if (pending && hello.answer?.requestId === pending.query.requestId) {
      const answer = hello.answer.result
      clearTimeout(pending.timer)
      this.pending.delete(hello.deviceId)
      if (answer.status === 'error') {
        pending.reject(new HttpOperationError(answer.error.code, answer.error.message))
      } else if (
        answer.value.rootId !== pending.query.rootId ||
        answer.value.parentId !== pending.query.parentId
      ) {
        pending.reject(new HttpOperationError('invalid-request', '手机目录应答与请求不匹配。'))
      } else {
        const entries = this.runtime.get(hello.deviceId)?.entries
        for (const item of answer.value.entries) {
          if (entries && entries.size < 32768) {
            entries.add(`${answer.value.rootId}\n${item.entryId}`)
          }
        }
        pending.resolve(answer.value)
      }
    }
    const roots = await this.adapter.listRoots()
    if (roots.status === 'error') {
      throw new HttpOperationError(roots.error.code, roots.error.message)
    }
    return {
      games: libraryCatalog(this.config, roots.value),
      links: libraryLinks(this.config, hello.deviceId),
      request: this.pending.get(hello.deviceId)?.query ?? null,
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
    if (this.pending.has(deviceId)) {
      return Promise.reject(new HttpOperationError('busy', '正在读取这台手机的目录。'))
    }
    const query = { requestId: randomUUID(), rootId, parentId }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(deviceId)
        reject(new HttpOperationError('network-failure', '手机未响应，请打开手机应用后重试。'))
      }, 8000)
      this.pending.set(deviceId, { query, resolve, reject, timer })
    })
  }
  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new HttpOperationError('network-failure', '服务已停止。'))
    }
    this.pending.clear()
    this.runtime.clear()
    this.disconnected.clear()
  }
}
