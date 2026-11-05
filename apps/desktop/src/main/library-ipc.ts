import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isOpaqueId } from '@savedata-sync/shared'
import type { LibraryGame } from '@savedata-sync/shared'
import { LIBRARY_CHANNELS } from '../bridge/library-bridge.ts'
import type { DesktopLibrary } from './library-store.ts'
import type { WindowsHttpService } from './http-service.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 注册本机页面使用的游戏配置和元数据 IPC，退出时移除；目录内容留在主进程。 */
export function registerLibraryIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  library: DesktopLibrary,
  service: WindowsHttpService,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  for (const [action, channel] of Object.entries(LIBRARY_CHANNELS)) {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!isTrusted(event)) {
          throw new HttpOperationError(
            'permission-denied',
            'This page cannot access game configuration.',
          )
        }
        if (action === 'read') {
          if (args.length !== 0) {
            throw new HttpOperationError('invalid-request', 'The parameters are invalid.')
          }
          return { status: 'success', value: library.snapshot() }
        }
        const value = args[0]
        if (args.length !== 1 || typeof value !== 'object' || value === null) {
          throw new HttpOperationError('invalid-request', 'The parameters are invalid.')
        }
        if (action === 'saveGames') {
          if (
            !('games' in value) ||
            !Array.isArray(value.games) ||
            Object.keys(value).length !== 1
          ) {
            throw new HttpOperationError('invalid-request', 'The game configuration is invalid.')
          }
          // store 在落盘前用完整 LibraryConfig 守卫校验每一项。
          if (service.hasWork()) {
            throw new HttpOperationError(
              'busy',
              'Finish the current transfer before changing game directories or links.',
            )
          }
          await library.saveGames(value.games as readonly LibraryGame[])
        } else if (action === 'device') {
          if (
            !('id' in value) ||
            !isOpaqueId(value.id) ||
            !('action' in value) ||
            !['disconnect', 'rename', 'forget'].includes(String(value.action)) ||
            Object.keys(value).some((key) => !['id', 'action', 'name'].includes(key))
          ) {
            throw new HttpOperationError('invalid-request', 'The device operation is invalid.')
          }
          if (service.hasWork()) {
            throw new HttpOperationError(
              'busy',
              'Finish the current transfer before changing devices.',
            )
          }
          const name = 'name' in value ? value.name : undefined
          if (
            name !== undefined &&
            (typeof name !== 'string' || !name.trim() || name.length > 128)
          ) {
            throw new HttpOperationError('invalid-request', 'The device name is invalid.')
          }
          await library.device(value.id, value.action as 'disconnect' | 'rename' | 'forget', name)
        } else {
          if (
            !('deviceId' in value) ||
            !isOpaqueId(value.deviceId) ||
            !('rootId' in value) ||
            !isOpaqueId(value.rootId) ||
            !('parentId' in value) ||
            (value.parentId !== null && !isOpaqueId(value.parentId)) ||
            Object.keys(value).length !== 3
          ) {
            throw new HttpOperationError('invalid-request', 'The directory request is invalid.')
          }
          return {
            status: 'success',
            value: await library.directory(value.deviceId, value.rootId, value.parentId),
          }
        }
        return { status: 'success', value: library.snapshot() }
      } catch (error) {
        return { status: 'error', error: toHttpError(error).operationError }
      }
    })
  }
  return () => {
    for (const channel of Object.values(LIBRARY_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
