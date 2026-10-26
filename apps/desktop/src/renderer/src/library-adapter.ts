import { unwrap } from '@savedata-sync/ui'
import type { UiAdapter, UiSnapshot } from '@savedata-sync/ui'

/** Renderer 通过有限桥操作配置和目录；桌面负责服务、授权与任务显示。 */
export function createDesktopLibraryAdapter(): UiAdapter {
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
    platform: 'windows',
    async read(): Promise<UiSnapshot> {
      const api = apis()
      const [library, service, roots] = await Promise.all([
        api.library.read(),
        api.service.status(),
        api.directories.listRoots(),
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
        grantedRoots: status.targets.map((item) => item.rootId),
        service: {
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
      }
    },
    async saveGames(games): Promise<void> {
      unwrap(await apis().library.saveGames(games))
    },
    chooseDirectory(shouldReceive) {
      const api = apis()
      return shouldReceive ? api.service.chooseTarget() : api.directories.chooseDirectory()
    },
    async revokeReceive(rootId): Promise<void> {
      unwrap(await apis().service.revokeTarget(rootId))
    },
    connect(): Promise<void> {
      return Promise.reject(new Error('请从手机连接电脑。'))
    },
    async device(id, action, name): Promise<void> {
      const api = apis()
      const current = unwrap(await api.library.read()).config.devices.find((item) => item.id === id)
      unwrap(
        await api.library.device(
          id,
          action === 'forget'
            ? 'forget'
            : action === 'disconnect'
              ? 'block'
              : action === 'rename' && current?.blocked
                ? 'block'
                : 'allow',
          name,
        ),
      )
    },
    directory(deviceId, rootId, parentId) {
      const api = apis()
      return deviceId === null
        ? api.directories.listDirectory(rootId, parentId)
        : api.library.directory(deviceId, rootId, parentId)
    },
    start(): Promise<void> {
      return Promise.reject(new Error('请在手机发起传输。'))
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
  }
}
