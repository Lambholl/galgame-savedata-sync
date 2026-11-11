import {
  isLibraryConfig,
  isLibraryPeer,
  isDirectoryListing,
  isOpaqueId,
  isOperationResult,
} from '@savedata-sync/shared'
import type {
  LibraryConfig,
  LibraryGame,
  LibraryPeer,
  DirectoryListing,
  OperationResult,
} from '@savedata-sync/shared'

/** 游戏库配置和已保存的对端设备。 */
export interface LibrarySnapshot {
  readonly config: LibraryConfig
  readonly peers: readonly LibraryPeer[]
}
/** 游戏库接口：读取和保存游戏，管理已保存的设备，浏览对端目录。 */
export interface DesktopLibraryApi {
  /** 读取游戏库。 */
  read(): Promise<OperationResult<LibrarySnapshot>>
  /** 用 games 替换全部本机游戏。 */
  saveGames(games: readonly LibraryGame[]): Promise<OperationResult<LibrarySnapshot>>
  /** 断开、重命名或忘记一台设备；rename 时 name 是新名称。 */
  device(
    id: string,
    action: 'disconnect' | 'rename' | 'forget',
    name?: string,
  ): Promise<OperationResult<LibrarySnapshot>>
  /** 列出已连接对端设备上一个目录的一层。 */
  directory(
    deviceId: string,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
}
/** 游戏库接口的 IPC 通道名。 */
export const LIBRARY_CHANNELS = {
  read: 'library:read',
  saveGames: 'library:games',
  device: 'library:device',
  directory: 'library:directory',
} as const
function isSnapshot(value: unknown): value is LibrarySnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'config' in value &&
    isLibraryConfig(value.config) &&
    'peers' in value &&
    Array.isArray(value.peers) &&
    value.peers.every(isLibraryPeer)
  )
}
/**
 * 用 invoke 创建冻结的 DesktopLibraryApi。
 *
 * @returns invoke 失败或返回格式不对时，对应方法返回 io-failure 错误结果。
 */
export function createLibraryBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopLibraryApi {
  async function call<T>(
    channel: string,
    args: readonly unknown[],
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    try {
      const value = await invoke(channel, ...args)
      if (isOperationResult(value, guard)) {
        return value
      }
    } catch {
      /* IPC 失效由外层返回统一的错误结果。 */
    }
    return {
      status: 'error',
      error: { code: 'io-failure', message: '无法读取或保存游戏配置。', canRetry: true },
    }
  }
  return Object.freeze({
    read: () => call(LIBRARY_CHANNELS.read, [], isSnapshot),
    saveGames: (games: readonly LibraryGame[]) =>
      call(LIBRARY_CHANNELS.saveGames, [{ games }], isSnapshot),
    device: (id: string, action: 'disconnect' | 'rename' | 'forget', name?: string) =>
      call(LIBRARY_CHANNELS.device, [{ id, action, ...(name ? { name } : {}) }], isSnapshot),
    directory: async (
      deviceId: string,
      rootId: string,
      parentId: string | null,
    ): Promise<OperationResult<DirectoryListing>> => {
      if (
        !isOpaqueId(deviceId) ||
        !isOpaqueId(rootId) ||
        (parentId !== null && !isOpaqueId(parentId))
      ) {
        return {
          status: 'error',
          error: { code: 'invalid-request', message: '目录引用无效。', canRetry: false },
        }
      }
      const result = await call(
        LIBRARY_CHANNELS.directory,
        [{ deviceId, rootId, parentId }],
        isDirectoryListing,
      )
      if (
        result.status === 'success' &&
        (result.value.rootId !== rootId || result.value.parentId !== parentId)
      ) {
        return {
          status: 'error',
          error: { code: 'invalid-request', message: '目录应答不匹配。', canRetry: false },
        }
      }
      return result
    },
  })
}
