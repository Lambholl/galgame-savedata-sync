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

export interface LibrarySnapshot {
  readonly config: LibraryConfig
  readonly peers: readonly LibraryPeer[]
}
/** 渲染进程使用的游戏库接口：保存本机游戏配置和公开设备信息，参数不含路径、URI 或文件内容。 */
export interface DesktopLibraryApi {
  read(): Promise<OperationResult<LibrarySnapshot>>
  saveGames(games: readonly LibraryGame[]): Promise<OperationResult<LibrarySnapshot>>
  device(
    id: string,
    action: 'disconnect' | 'rename' | 'forget',
    name?: string,
  ): Promise<OperationResult<LibrarySnapshot>>
  directory(
    deviceId: string,
    rootId: string,
    parentId: string | null,
  ): Promise<OperationResult<DirectoryListing>>
}
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
/** 创建冻结的游戏库 IPC 客户端；响应无效时 resolve 为脱敏错误。 */
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
