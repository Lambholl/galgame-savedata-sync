import { OperationFailure, unwrap } from '@savedata-sync/shared'
import type { Translate } from '@savedata-sync/shared'
import type { DesktopLibraryAdapter, DesktopSnapshot } from './library-types.ts'
import { desktopSync } from './sync-adapter.ts'

/** 创建桌面游戏库适配器：渲染进程通过 IPC 桥操作配置和目录；桌面负责服务、授权和任务显示。 */
export function createDesktopLibraryAdapter(): DesktopLibraryAdapter {
  function apis() {
    const library = window.desktopLibrary,
      service = window.desktopService,
      directories = window.desktopDirectories
    if (!library || !service || !directories) {
      throw new OperationFailure('unsupported-operation', 'Open this page in the desktop app.')
    }
    return { library, service, directories }
  }
  return {
    async read(t: Translate): Promise<DesktopSnapshot> {
      const api = apis()
      const sync = desktopSync()
      const [library, service, roots, copies, restores, activity] = await Promise.all([
        api.library.read(),
        api.service.status(),
        api.directories.listRoots(),
        sync.copies(),
        sync.restores(),
        sync.activity(),
      ])
      const config = unwrap(library),
        status = unwrap(service)
      return {
        warning: null,
        config: config.config,
        deviceName: status.deviceName,
        peers: config.peers.map((item) => ({
          ...item,
          isConnected: item.isConnected && Boolean(status.listener),
        })),
        roots: unwrap(roots),
        service: {
          port: status.configuredPort,
          isRunning: Boolean(status.listener),
          addresses: status.listener?.addresses ?? [],
        },
        tasks: status.tasks.map((local) => ({
          id: local.transferId,
          title: t(local.direction === 'android-to-windows' ? 'task.phoneToPc' : 'task.pcToPhone'),
          local,
          remote: null,
          upload: local.direction === 'android-to-windows',
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
