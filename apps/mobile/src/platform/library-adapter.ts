import {
  emptyLibrary,
  isLibraryConfig,
  libraryCatalog,
  libraryLinks,
  mergeCatalogLinks,
  matchesSyncProjectBinding,
  normalizeHttpAddress,
  resolveSyncProjectBinding,
  PROTOCOL_VERSION,
} from '@savedata-sync/shared'
import type {
  BatchDeviceDescriptor,
  CatalogGame,
  CatalogReply,
  DirectoryReference,
  LibraryConfig,
  OperationResult,
  SyncProjectBinding,
} from '@savedata-sync/shared'
import { unwrap, taskIsActive } from '@savedata-sync/shared'
import type { TransferTask, TransferRequest } from '@savedata-sync/shared'
import type { MobileLibraryAdapter, MobileSnapshot } from './library-types'
import { androidDirectories as defaultDirectories } from './saf-directories'
import {
  androidControl as defaultControl,
  androidTransfers as defaultTransfers,
} from './http-transfers'
import { CONTROL_CLOSE_DISCONNECTED } from './control-channel'
import type { AndroidControlApi } from './control-channel'
import type { AndroidDirectoryApi } from './saf-directory-bridge'
import type {
  AndroidTransferApi,
  CurrentTransfer,
  TransferStartOptions,
} from './http-transfer-bridge'

/** 平台依赖可由集成验证替换；默认使用真实原生桥和本机持久存储。 */
export interface MobileLibraryDependencies {
  readonly directories: AndroidDirectoryApi
  readonly transfers: AndroidTransferApi
  readonly control: AndroidControlApi
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  readonly hasSyncWork: () => Promise<boolean>
}

const CONFIG_KEY = 'savedata-sync:library:1'
/** 控制通道断开超过这个时长且没有任务时，本机断开这台设备。 */
const CONTROL_GRACE_MS = 10000
/**
 * Android 仅持久化公开 ID/配置；原生拥有连接和任务，网页重载后重新查询。
 * 在线以控制通道为准；目录表只在本机或对方变化时重新交换，对方的目录读取经控制通道应答。
 */
export function createMobileLibraryAdapter(
  dependencies?: Partial<MobileLibraryDependencies>,
): MobileLibraryAdapter {
  const androidDirectories = dependencies?.directories ?? defaultDirectories
  const androidTransfers = dependencies?.transfers ?? defaultTransfers
  const control = dependencies?.control ?? defaultControl
  const storage = dependencies?.storage ?? localStorage
  let config: LibraryConfig | undefined
  const catalogs = new Map<string, readonly CatalogGame[]>()
  /** 每台设备上次交换成功的本机目录表，变化时才重新交换。 */
  const pushed = new Map<string, string>()
  const stale = new Set<string>()
  const closedSince = new Map<string, number>()
  const dropped = new Set<string>()
  let selectedId: string | null = null
  let current: CurrentTransfer | null = null
  let task: TransferTask | null = null
  let hasRestored = false
  let descriptors: readonly BatchDeviceDescriptor[] = []
  function load(): LibraryConfig {
    if (config) {
      return config
    }
    const raw = storage.getItem(CONFIG_KEY)
    const value: unknown = raw === null ? emptyLibrary() : JSON.parse(raw)
    if (!isLibraryConfig(value)) {
      throw new Error('游戏配置损坏，请保留应用数据后检查。')
    }
    config = value
    return value
  }
  function save(value: LibraryConfig): void {
    if (!isLibraryConfig(value)) {
      throw new Error('游戏或设备配置无效。')
    }
    if (JSON.stringify(load()) === JSON.stringify(value)) {
      return
    }
    storage.setItem(CONFIG_KEY, JSON.stringify(value))
    config = value
  }
  control.onState((id, state) => {
    if (state.isOpen) {
      closedSince.delete(id)
      dropped.delete(id)
    } else {
      if (!closedSince.has(id)) {
        closedSince.set(id, Date.now())
      }
      if (state.code === CONTROL_CLOSE_DISCONNECTED) {
        dropped.add(id)
      }
    }
  })
  control.onEvent('catalog.changed', (id) => stale.add(id))
  control.onRequest('directory.list', async (id, query) => {
    if (!descriptors.some((item) => item.device.deviceId === id)) {
      return {
        status: 'error',
        error: { code: 'session-mismatch', message: '设备连接已变化。', canRetry: false },
      }
    }
    if (!load().games.some((item) => item.rootId === query.rootId)) {
      return {
        status: 'error',
        error: { code: 'permission-denied', message: '这个目录未配置到游戏。', canRetry: false },
      }
    }
    return androidDirectories.listDirectory(query.rootId, query.parentId)
  })
  /** 交换目录表并合并对方的关联；失败原样返回，由调用者决定是否断开。 */
  async function exchange(
    id: string,
    roots: readonly DirectoryReference[],
  ): Promise<OperationResult<CatalogReply>> {
    const push = { games: libraryCatalog(load(), roots), links: libraryLinks(load(), id) }
    const result = await androidTransfers.exchangeCatalog(id, push)
    if (result.status === 'success') {
      pushed.set(id, JSON.stringify(push))
      stale.delete(id)
      catalogs.set(id, result.value.games)
      save(mergeCatalogLinks(load(), id, result.value.links))
    }
    return result
  }
  async function hasWork(): Promise<boolean> {
    return Boolean((task && taskIsActive(task)) || (await dependencies?.hasSyncWork?.()))
  }
  async function select(id: string): Promise<BatchDeviceDescriptor> {
    const descriptor = descriptors.find((item) => item.device.deviceId === id)
    if (!descriptor) {
      throw new Error('请先连接这台电脑。')
    }
    if (selectedId !== id) {
      unwrap(await androidTransfers.selectDevice(id))
      unwrap(await androidTransfers.listRemoteRoots())
      selectedId = id
    }
    return descriptor
  }
  async function refreshTask(): Promise<void> {
    if (!hasRestored) {
      current = unwrap(await androidTransfers.current())
      hasRestored = true
      if (current) {
        task = {
          id: current.options.request.transferId,
          title: current.device.device.displayName,
          local: null,
          remote: null,
          upload: current.upload,
          names: {},
        }
      }
    }
    if (!current || !task || !taskIsActive(task)) {
      return
    }
    const id = current.options.request.transferId
    const local = await androidTransfers.query(id)
    const remote = await androidTransfers.queryRemote(id, true)
    const manifest = await androidTransfers.getManifest(id)
    task = {
      ...task,
      local: local.status === 'success' ? local.value : task.local,
      remote: remote.status === 'success' ? remote.value : task.remote,
      names:
        manifest.status === 'success'
          ? Object.fromEntries(manifest.value.files.map((file) => [file.fileId, file.sourceName]))
          : task.names,
    }
  }
  async function disconnect(id: string): Promise<void> {
    unwrap(await androidTransfers.disconnectDevice(id))
    descriptors = descriptors.filter((item) => item.device.deviceId !== id)
    pushed.delete(id)
    stale.delete(id)
    closedSince.delete(id)
    dropped.delete(id)
    if (selectedId === id) {
      selectedId = null
    }
  }
  async function assertCanEditGames(): Promise<void> {
    await refreshTask()
    if (await hasWork()) {
      throw new Error('结束当前传输后再修改游戏目录或关联。')
    }
  }
  async function binding(
    transfer: TransferRequest,
    shouldRefresh: boolean,
  ): Promise<SyncProjectBinding> {
    const roots = unwrap(await androidDirectories.listRoots())
    if (shouldRefresh) {
      unwrap(await exchange(transfer.deviceId, roots))
    }
    const device = load().devices.find((item) => item.id === transfer.deviceId)
    if (!device) {
      throw new Error('项目关联的设备已移除，请重新选择。')
    }
    const value = unwrap(
      resolveSyncProjectBinding(
        load(),
        roots,
        {
          device,
          isConnected: descriptors.some((item) => item.device.deviceId === transfer.deviceId),
          games: catalogs.get(transfer.deviceId) ?? [],
        },
        transfer.projectId,
      ),
    )
    const sourceRootId = transfer.upload ? value.localRootId : value.remoteRootId
    const targetRootId = transfer.upload ? value.remoteRootId : value.localRootId
    if (sourceRootId !== transfer.sourceRootId || targetRootId !== transfer.targetRootId) {
      throw new Error('项目目录已变化，请重新打开预览。')
    }
    return value
  }
  return {
    async read(): Promise<MobileSnapshot> {
      load()
      const roots = unwrap(await androidDirectories.listRoots())
      descriptors = unwrap(await androidTransfers.connections())
      const connectedIds = new Set<string>()
      await refreshTask()
      for (const descriptor of descriptors) {
        const id = descriptor.device.deviceId
        if (!load().devices.some((item) => item.id === id)) {
          save({
            ...load(),
            devices: [
              ...load().devices,
              { id, name: descriptor.device.displayName, address: null, blocked: false },
            ],
          })
        }
        const key = JSON.stringify({
          games: libraryCatalog(load(), roots),
          links: libraryLinks(load(), id),
        })
        if (stale.has(id) || pushed.get(id) !== key) {
          const result = await exchange(id, roots)
          if (result.status === 'error') {
            if (!(await hasWork())) {
              await disconnect(id)
            }
            continue
          }
        }
        if (control.state(id)?.isOpen) {
          connectedIds.add(id)
          continue
        }
        if (!closedSince.has(id)) {
          closedSince.set(id, Date.now())
        }
        // 电脑主动断开，或控制通道断开超过宽限期且没有任务时，本机也断开。
        const since = closedSince.get(id) ?? Date.now()
        if ((dropped.has(id) || Date.now() - since >= CONTROL_GRACE_MS) && !(await hasWork())) {
          await disconnect(id)
        }
      }
      return {
        warning: null,
        config: load(),
        roots,
        peers: load().devices.map((device) => ({
          device,
          isConnected: connectedIds.has(device.id),
          games: catalogs.get(device.id) ?? [],
        })),
        tasks: task ? [task] : [],
      }
    },
    async saveGames(games): Promise<void> {
      await assertCanEditGames()
      if (!isLibraryConfig({ ...load(), games })) {
        throw new Error('游戏或设备配置无效。')
      }
      const roots = unwrap(await androidDirectories.listRoots())
      if (
        games.some(
          (game) => game.rootId !== null && !roots.some((root) => root.rootId === game.rootId),
        )
      ) {
        throw new Error('请选择已授权的本机存档目录。')
      }
      save({ ...load(), games })
    },
    chooseDirectory() {
      return androidTransfers.chooseTarget()
    },
    async connect(address, expectedDeviceId): Promise<void> {
      if (descriptors.length) {
        throw new Error('busy')
      }
      let normalized: string
      try {
        normalized = normalizeHttpAddress(address)
      } catch {
        throw new Error('invalid-request')
      }
      const descriptor = unwrap(await androidTransfers.connect(normalized))
      const id = descriptor.device.deviceId
      try {
        if (expectedDeviceId && expectedDeviceId !== id) {
          throw new Error('session-mismatch')
        }
        const roots = unwrap(await androidDirectories.listRoots())
        const reply = unwrap(
          await androidTransfers.exchangeCatalog(id, {
            games: libraryCatalog(load(), roots),
            links: libraryLinks(load(), id),
          }),
        )
        const saved = load().devices.find((item) => item.id === id)
        save({
          ...load(),
          devices: [
            ...load().devices.filter((item) => item.id !== id),
            {
              id,
              name: saved?.name ?? descriptor.device.displayName,
              address: normalized,
              blocked: false,
            },
          ],
        })
        save(mergeCatalogLinks(load(), id, reply.links))
        catalogs.set(id, reply.games)
        closedSince.set(id, Date.now())
        descriptors = [descriptor]
        selectedId = null
      } catch (error) {
        // 连接未完成时直接释放本机会话，避免等待对端告别请求再次超时。
        await androidTransfers.disconnect()
        throw error
      }
    },
    async device(id, action, name, address): Promise<void> {
      if (action === 'disconnect') {
        await disconnect(id)
        return
      }
      if (action === 'allow') {
        const item = load().devices.find((value) => value.id === id)
        if (!item?.address) {
          throw new Error('invalid-request')
        }
        await this.connect(item.address, id)
        return
      }
      if (action === 'forget') {
        if (descriptors.some((item) => item.device.deviceId === id)) {
          await disconnect(id)
        }
        save({
          ...load(),
          devices: load().devices.filter((item) => item.id !== id),
          games: load().games.map((item) => ({
            ...item,
            links: item.links.filter((link) => link.deviceId !== id),
          })),
        })
        return
      }
      if (
        address !== undefined &&
        descriptors.some((item) => item.device.deviceId === id) &&
        load().devices.find((item) => item.id === id)?.address !== normalizeHttpAddress(address)
      ) {
        throw new Error('请先断开设备，再修改地址。')
      }
      save({
        ...load(),
        devices: load().devices.map((item) =>
          item.id === id
            ? {
                ...item,
                name: name ?? item.name,
                ...(address !== undefined ? { address: normalizeHttpAddress(address) } : {}),
              }
            : item,
        ),
      })
    },
    async directory(deviceId, rootId, parentId) {
      if (deviceId === null) {
        return androidDirectories.listDirectory(rootId, parentId)
      }
      await select(deviceId)
      return androidTransfers.listRemoteDirectory(rootId, parentId)
    },
    async start(value: TransferRequest): Promise<void> {
      const transfer = structuredClone(value)
      const expected = await binding(transfer, false)
      const descriptor = await select(transfer.deviceId)
      if (!unwrap(await androidTransfers.requestNotifications())) {
        throw new Error('请允许传输通知后重试。')
      }
      const actual = await binding(transfer, true)
      if (!matchesSyncProjectBinding(expected, actual)) {
        throw new Error('项目或设备关联已变化，请重新打开预览。')
      }
      const options: TransferStartOptions = {
        request: {
          protocolVersion: PROTOCOL_VERSION,
          transferId: crypto.randomUUID(),
          sourceRootId: transfer.sourceRootId,
          files: transfer.files.map((file, index) => ({
            fileId: `f${String(index + 1).padStart(6, '0')}`,
            entryId: file.entryId,
          })),
        },
        targetRootId: transfer.targetRootId,
        targets: transfer.files.map((file, index) => ({
          fileId: `f${String(index + 1).padStart(6, '0')}`,
          parentId: transfer.targetParentId,
          name: transfer.names[file.entryId] ?? file.name,
        })),
      }
      unwrap(
        await (transfer.upload
          ? androidTransfers.startUpload(options)
          : androidTransfers.startDownload(options)),
      )
      current = { options, upload: transfer.upload, device: descriptor }
      hasRestored = true
      task = {
        id: options.request.transferId,
        title: transfer.title,
        local: null,
        remote: null,
        upload: transfer.upload,
        names: Object.fromEntries(
          transfer.files.map((file, index) => [
            `f${String(index + 1).padStart(6, '0')}`,
            file.name,
          ]),
        ),
      }
    },
    async cancel(id): Promise<void> {
      unwrap(await androidTransfers.cancel(id))
    },
    async cleanup(): Promise<void> {
      if (!unwrap(await androidTransfers.retryCleanup())) {
        throw new Error('仍有临时文件未清理。')
      }
    },
  }
}
