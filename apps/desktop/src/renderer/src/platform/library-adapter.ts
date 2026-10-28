import { unwrap } from '@savedata-sync/shared'
import type { DesktopLibraryAdapter, DesktopSnapshot } from './library-types.ts'
import { desktopSync } from './sync-adapter.ts'

/** Renderer 通过有限桥操作配置和目录；桌面负责服务、授权与任务显示。 */
export function createDesktopLibraryAdapter(): DesktopLibraryAdapter {
  function apis() {
    const library = window.desktopLibrary,
      service = window.desktopService,
      directories = window.desktopDirectories
    if (!library || !service || !directories) {
      throw new Error('请在桌面应用中打开此界面。')
    }
    return { library, service, directories }
  }
  return {
    async read(): Promise<DesktopSnapshot> {
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
          title: local.direction === 'android-to-windows' ? '手机 → 电脑' : '电脑 → 手机',
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
