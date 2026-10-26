import {
  emptyLibrary,
  isLibraryConfig,
  libraryCatalog,
  libraryLinks,
  mergeCatalogLinks,
  normalizeHttpAddress,
  PROTOCOL_VERSION,
} from '@savedata-sync/shared'
import type {
  BatchDeviceDescriptor,
  CatalogGame,
  DirectoryAnswer,
  LibraryConfig,
  OperationResult,
  DirectoryListing,
} from '@savedata-sync/shared'
import { unwrap, taskIsActive } from '@savedata-sync/ui'
import type { UiAdapter, UiSnapshot, UiTask, UiTransfer } from '@savedata-sync/ui'
import { androidDirectories } from './saf-directories'
import { androidTransfers } from './http-transfers'
import type { CurrentTransfer, TransferStartOptions } from './http-transfer-bridge'

const CONFIG_KEY = 'savedata-sync:library:1'
/** Android 仅持久化公开 ID/配置；原生拥有连接和任务，网页重载后重新查询。 */
export function createMobileLibraryAdapter(): UiAdapter {
  let config: LibraryConfig | undefined
  const catalogs = new Map<string, readonly CatalogGame[]>()
  const answers = new Map<string, DirectoryAnswer>()
  const granted = new Set<string>()
  let selectedId: string | null = null
  let current: CurrentTransfer | null = null
  let task: UiTask | null = null
  let hasRestored = false
  let descriptors: readonly BatchDeviceDescriptor[] = []
  function load(): LibraryConfig {
    if (config) {
      return config
    }
    const raw = localStorage.getItem(CONFIG_KEY)
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
    localStorage.setItem(CONFIG_KEY, JSON.stringify(value))
    config = value
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
    if (selectedId === id) {
      selectedId = null
    }
  }
  return {
    platform: 'android',
    async read(): Promise<UiSnapshot> {
      load()
      let warning: string | null = null
      const roots = unwrap(await androidDirectories.listRoots())
      descriptors = unwrap(await androidTransfers.connections())
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
        const result = await androidTransfers.exchangeCatalog(id, {
          games: libraryCatalog(load(), roots),
          links: libraryLinks(load(), id),
          answer: answers.get(id) ?? null,
        })
        if (result.status === 'error') {
          warning = result.error.message
          if (
            result.error.code === 'session-mismatch' ||
            result.error.code === 'permission-denied' ||
            result.error.code === 'busy'
          ) {
            if (!task || !taskIsActive(task)) {
              await disconnect(id)
            }
          }
          continue
        }
        answers.delete(id)
        catalogs.set(id, result.value.games)
        save(mergeCatalogLinks(load(), id, result.value.links))
        const request = result.value.request
        if (request) {
          const isAllowed = load().games.some((item) => item.rootId === request.rootId)
          const response: OperationResult<DirectoryListing> = isAllowed
            ? await androidDirectories.listDirectory(request.rootId, request.parentId)
            : {
              status: 'error',
              error: {
                code: 'permission-denied',
                message: '这个目录未配置到游戏。',
                canRetry: false,
              },
            }
          answers.set(id, { requestId: request.requestId, result: response })
        }
      }
      await refreshTask()
      return {
        warning,
        config: load(),
        roots,
        peers: load().devices.map((device) => ({
          device,
          isConnected: descriptors.some((item) => item.device.deviceId === device.id),
          games: catalogs.get(device.id) ?? [],
        })),
        grantedRoots: [...granted],
        service: null,
        tasks: task ? [task] : [],
      }
    },
    saveGames(games): Promise<void> {
      return Promise.resolve().then(() => save({ ...load(), games }))
    },
    async chooseDirectory(shouldReceive) {
      const result = await (shouldReceive
        ? androidTransfers.chooseTarget()
        : androidDirectories.chooseDirectory())
      if (shouldReceive && result.status === 'selected') {
        granted.add(result.directory.rootId)
      }
      return result
    },
    async connect(address, expectedDeviceId): Promise<void> {
      if (descriptors.length) {
        throw new Error('请先断开当前设备。')
      }
      const normalized = normalizeHttpAddress(address)
      const descriptor = unwrap(await androidTransfers.connect(normalized))
      const id = descriptor.device.deviceId
      try {
        if (expectedDeviceId && expectedDeviceId !== id) {
          throw new Error('这个地址属于另一台设备，原游戏关联已保留。请将新设备单独添加。')
        }
        const roots = unwrap(await androidDirectories.listRoots())
        const reply = unwrap(
          await androidTransfers.exchangeCatalog(id, {
            games: libraryCatalog(load(), roots),
            links: libraryLinks(load(), id),
            answer: null,
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
        descriptors = [descriptor]
        selectedId = null
      } catch (error) {
        await androidTransfers.disconnectDevice(id)
        throw error
      }
    },
    revokeReceive(): Promise<void> {
      return Promise.reject(new Error('手机接收授权请在系统目录权限中管理。'))
    },
    async device(id, action, name, address): Promise<void> {
      if (action === 'disconnect') {
        await disconnect(id)
        return
      }
      if (action === 'allow') {
        const item = load().devices.find((value) => value.id === id)
        if (!item?.address) {
          throw new Error('设备地址缺失。')
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
    async start(transfer: UiTransfer): Promise<void> {
      const descriptor = await select(transfer.deviceId)
      if (!unwrap(await androidTransfers.requestNotifications())) {
        throw new Error('请允许传输通知后重试。')
      }
      if (!transfer.upload && !granted.has(transfer.targetRootId)) {
        throw new Error('请先允许本机目录接收文件。')
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
    service(): Promise<void> {
      return Promise.reject(new Error('请在电脑开启服务。'))
    },
  }
}
