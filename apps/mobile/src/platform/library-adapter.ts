import {
  emptyLibrary,
  isLibraryConfig,
  libraryCatalog,
  libraryLinks,
  mergeCatalogLinks,
  matchesSyncProjectBinding,
  normalizeHttpAddress,
  OperationFailure,
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
import { appStorage } from './app-storage'

/** 游戏库适配器的依赖。 */
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
 * 创建移动游戏库适配器。设备是否在线以控制通道是否打开为准；
 * 目录表只在本机或对方变化时重新交换；控制通道断开超过 CONTROL_GRACE_MS 且没有任务时断开这台设备。
 */
export function createMobileLibraryAdapter(
  dependencies?: Partial<MobileLibraryDependencies>,
): MobileLibraryAdapter {
  const androidDirectories = dependencies?.directories ?? defaultDirectories
  const androidTransfers = dependencies?.transfers ?? defaultTransfers
  const control = dependencies?.control ?? defaultControl
  const storage = dependencies?.storage ?? appStorage
  let config: LibraryConfig | undefined
  let deviceName: string | null = null
  const catalogs = new Map<string, readonly CatalogGame[]>()
  /** 每台设备上次交换成功的本机目录表，变化时才重新交换。 */
  const pushed = new Map<string, string>()
  const stale = new Set<string>()
  const closedSince = new Map<string, number>()
  const dropped = new Set<string>()
  /** 连上后控制通道还没打开过的设备。 */
  const opening = new Set<string>()
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
      throw new OperationFailure(
        'io-failure',
        'The game configuration is damaged. Preserve app data and inspect it.',
      )
    }
    config = value
    return value
  }
  function save(value: LibraryConfig): void {
    if (!isLibraryConfig(value)) {
      throw new OperationFailure('invalid-request', 'The game or device configuration is invalid.')
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
      opening.delete(id)
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
        error: {
          code: 'session-mismatch',
          message: 'The device connection changed.',
          canRetry: false,
        },
      }
    }
    if (!load().games.some((item) => item.rootId === query.rootId)) {
      return {
        status: 'error',
        error: {
          code: 'permission-denied',
          message: 'This directory is not configured for a game.',
          canRetry: false,
        },
      }
    }
    return androidDirectories.listDirectory(query.rootId, query.parentId)
  })
  /** 交换目录表并合并对方的关联；失败时返回错误结果。 */
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
      throw new OperationFailure('session-mismatch', 'Connect to this PC first.')
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
    forgetSession(id)
  }
  // 控制通道异常断开后，会话保留 CONTROL_GRACE_MS 等对方恢复；这期间界面已显示未连接，用户再次连接时不再等。
  // 只释放本机会话：对方已经断开，向它发告别请求只会等到超时。
  // 刚连上、控制通道还没打开的会话不算断开：释放它会让连点“连接”断开刚建立的会话再连一次。
  /** 释放控制通道已断开、还在宽限期内的本机会话；控制通道还开着、还没打开过或有进行中的任务时保留。 */
  async function releaseClosedSession(): Promise<void> {
    const ids = descriptors.map((item) => item.device.deviceId)
    if (
      !ids.length ||
      ids.some((id) => control.state(id)?.isOpen || opening.has(id)) ||
      (await hasWork())
    ) {
      return
    }
    unwrap(await androidTransfers.disconnect())
    for (const id of ids) {
      forgetSession(id)
    }
  }
  /** 清掉本机为这台设备记录的目录交换和控制通道状态；原生会话不在这里释放。 */
  function forgetSession(id: string): void {
    descriptors = descriptors.filter((item) => item.device.deviceId !== id)
    pushed.delete(id)
    stale.delete(id)
    closedSince.delete(id)
    dropped.delete(id)
    opening.delete(id)
    if (selectedId === id) {
      selectedId = null
    }
  }
  async function assertCanEditGames(): Promise<void> {
    await refreshTask()
    if (await hasWork()) {
      throw new OperationFailure(
        'busy',
        'Finish the current transfer before changing game directories or links.',
      )
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
      throw new OperationFailure(
        'not-found',
        'The device linked to the project was removed. Select it again.',
      )
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
      throw new OperationFailure(
        'task-conflict',
        'The project directory changed. Reopen the preview.',
      )
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
              { id, name: descriptor.device.displayName, address: null, blocked: false },
              ...load().devices,
            ],
          })
        }
        const key = JSON.stringify({
          games: libraryCatalog(load(), roots),
          links: libraryLinks(load(), id),
        })
        // 对方的目录变回可用时不会通知本机。目录表里还有不可用的目录时每次都重新交换，
        // 否则目录恢复后刷新也一直报授权失效，要重连才好。
        const hasUnavailableRoot =
          catalogs.get(id)?.some((game) => game.root && game.root.authorization !== 'granted') ??
          false
        if (stale.has(id) || hasUnavailableRoot || pushed.get(id) !== key) {
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
          opening.delete(id)
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
      // 只在读到后缓存；一次失败不影响连接和任务，下次再读。
      if (deviceName === null) {
        const name = await androidTransfers.deviceName()
        deviceName = name.status === 'success' ? name.value : null
      }
      return {
        warning: null,
        config: load(),
        deviceName,
        roots,
        peers: load().devices.map((device) => ({
          device,
          isConnected: connectedIds.has(device.id),
          games: catalogs.get(device.id) ?? [],
        })),
        connectingId:
          descriptors
            .map((item) => item.device.deviceId)
            .find((id) => opening.has(id) && !connectedIds.has(id)) ?? null,
        tasks: task ? [task] : [],
      }
    },
    savedConfig() {
      return load()
    },
    async saveGames(games): Promise<void> {
      await assertCanEditGames()
      if (!isLibraryConfig({ ...load(), games })) {
        throw new OperationFailure(
          'invalid-request',
          'The game or device configuration is invalid.',
        )
      }
      const roots = unwrap(await androidDirectories.listRoots())
      if (
        games.some(
          (game) => game.rootId !== null && !roots.some((root) => root.rootId === game.rootId),
        )
      ) {
        throw new OperationFailure(
          'authorization-expired',
          'Select an authorized local save directory.',
        )
      }
      save({ ...load(), games })
    },
    chooseDirectory() {
      return androidTransfers.chooseTarget()
    },
    async connect(address, expectedDeviceId): Promise<string> {
      await releaseClosedSession()
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
        const name =
          load().devices.find((item) => item.id === id)?.name ?? descriptor.device.displayName
        // 连上的设备移到开头，已保存的设备按最近连接排序。
        save({
          ...load(),
          devices: [
            {
              id,
              name,
              address: normalized,
              blocked: false,
            },
            ...load().devices.filter((item) => item.id !== id),
          ],
        })
        save(mergeCatalogLinks(load(), id, reply.links))
        catalogs.set(id, reply.games)
        closedSince.set(id, Date.now())
        if (!control.state(id)?.isOpen) {
          opening.add(id)
        }
        descriptors = [descriptor]
        selectedId = null
        return name
      } catch (error) {
        // 连接未完成时直接释放本机会话，避免等待对端告别请求再次超时。
        await androidTransfers.disconnect()
        throw error
      }
    },
    async connectCandidates(candidates, expectedDeviceId): Promise<string> {
      let lastError: unknown = new Error('invalid-request')
      await releaseClosedSession()
      for (const candidate of candidates) {
        if (descriptors.length) {
          throw new Error('busy')
        }
        try {
          return await this.connect(candidate, expectedDeviceId)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
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
        throw new OperationFailure(
          'unsupported-operation',
          'Disconnect the device before changing its address.',
        )
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
        throw new OperationFailure('permission-denied', 'Allow transfer notifications and retry.')
      }
      const actual = await binding(transfer, true)
      if (!matchesSyncProjectBinding(expected, actual)) {
        throw new OperationFailure(
          'task-conflict',
          'The project or device link changed. Reopen the preview.',
        )
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
        throw new OperationFailure('cleanup-failed', 'Temporary files still need cleanup.')
      }
    },
  }
}
