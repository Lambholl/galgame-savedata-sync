import { OperationFailure, unwrap } from '@savedata-sync/shared'
import type { Translate } from '@savedata-sync/shared'
import type { DesktopLibraryAdapter, DesktopSnapshot } from './library-types.ts'
import { desktopSync } from './sync-adapter.ts'

/** 创建桌面游戏库适配器。 */
export function createDesktopLibraryAdapter(): DesktopLibraryAdapter {
  function apis() {
    const library = window.desktopLibrary,
      service = window.desktopService,
      directories = window.desktopDirectories,
      dialer = window.desktopDialer
    if (!library || !service || !directories || !dialer) {
      throw new OperationFailure('unsupported-operation', 'Open this page in the desktop app.')
    }
    return { library, service, directories, dialer }
  }
  return {
    async read(t: Translate, shouldWatchNearby: boolean): Promise<DesktopSnapshot> {
      const api = apis()
      const sync = desktopSync()
      const [library, service, dialer, roots, copies, restores, activity] = await Promise.all([
        api.library.read(),
        api.service.status(),
        shouldWatchNearby ? api.dialer.watchNearby() : api.dialer.status(),
        api.directories.listRoots(),
        sync.copies(),
        sync.restores(),
        sync.activity(),
      ])
      const config = unwrap(library),
        status = unwrap(service),
        dialerStatus = unwrap(dialer)
      return {
        warning: null,
        config: config.config,
        deviceName: status.deviceName,
        // 连进本机的设备在服务停止时已经断开；本机拨号连着的设备不受本机服务影响。
        peers: config.peers.map((item) => ({
          ...item,
          isConnected:
            item.isConnected &&
            (Boolean(status.listener) || item.device.id === dialerStatus.session?.deviceId),
        })),
        dialer: dialerStatus,
        roots: unwrap(roots),
        service: {
          deviceId: status.deviceId,
          port: status.configuredPort,
          listener: status.listener && {
            port: status.listener.port,
            startedAt: status.listener.startedAt,
          },
          ipv4Addresses: status.listener ? status.listener.ipv4Addresses : [],
          discovery: status.discovery,
        },
        tasks: status.tasks.map((local) => ({
          id: local.transferId,
          title: t(
            local.direction === 'android-to-windows' ? 'task.remoteToLocal' : 'task.localToRemote',
          ),
          local,
          remote: null,
          isUpload: local.direction === 'android-to-windows',
          names: {},
        })),
        copies: unwrap(copies),
        restores: unwrap(restores),
        hasActiveOperation: unwrap(activity),
      }
    },
    async saveGames(games): Promise<void> {
      unwrap(await apis().library.saveGames(games))
    },
    chooseDirectory() {
      return apis().service.chooseTarget()
    },
    async connect(addresses, expectedDeviceId) {
      return unwrap(await apis().dialer.connect(addresses, expectedDeviceId))
    },
    async connectSaved(deviceId) {
      return unwrap(await apis().dialer.connectSaved(deviceId))
    },
    async device(id, action, name): Promise<void> {
      const api = apis()
      unwrap(await api.library.device(id, action, name))
    },
    directory(deviceId, rootId, parentId) {
      const api = apis()
      return deviceId === null
        ? api.directories.listDirectory(rootId, parentId)
        : api.library.directory(deviceId, rootId, parentId)
    },
    async cancel(id): Promise<void> {
      unwrap(await apis().service.cancel(id))
    },
    async cleanup(): Promise<void> {
      unwrap(await apis().service.retryCleanup())
    },
    async service(shouldStart, port): Promise<void> {
      const api = apis()
      unwrap(await (shouldStart ? api.service.start(port) : api.service.stop()))
    },
    async randomizePort(): Promise<number> {
      return unwrap(await apis().service.randomizePort()).configuredPort
    },
  }
}
