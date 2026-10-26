import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isOpaqueId } from '@savedata-sync/shared'
import type { LibraryGame } from '@savedata-sync/shared'
import { LIBRARY_CHANNELS } from '../library-bridge.ts'
import type { DesktopLibrary } from './library-store.ts'
import type { WindowsHttpService } from './http-service.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 本机页面专用的配置与元数据通道；目录内容仍在原生层，退出时移除 handlers。 */
export function registerLibraryIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  library: DesktopLibrary,
  service: WindowsHttpService,
  isTrusted: (event: IpcMainInvokeEvent) => boolean,
): () => void {
  for (const [action, channel] of Object.entries(LIBRARY_CHANNELS))
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!isTrusted(event))
          throw new HttpOperationError('permission-denied', '此页面无法访问游戏配置。')
        if (action === 'read') {
          if (args.length !== 0) throw new HttpOperationError('invalid-request', '参数无效。')
          return { status: 'success', value: library.snapshot() }
        }
        const value = args[0]
        if (args.length !== 1 || typeof value !== 'object' || value === null)
          throw new HttpOperationError('invalid-request', '参数无效。')
        if (action === 'saveGames') {
          if (!('games' in value) || !Array.isArray(value.games) || Object.keys(value).length !== 1)
            throw new HttpOperationError('invalid-request', '游戏配置无效。')
          // store 在落盘前用完整 LibraryConfig 守卫校验每一项。
          await library.saveGames(value.games as readonly LibraryGame[])
        } else if (action === 'device') {
          if (
            !('id' in value) ||
            !isOpaqueId(value.id) ||
            !('action' in value) ||
            !['block', 'allow', 'forget'].includes(String(value.action)) ||
            Object.keys(value).some((key) => !['id', 'action', 'name'].includes(key))
          )
            throw new HttpOperationError('invalid-request', '设备操作无效。')
          if (service.getStates().some((item) => item.status === 'running'))
            throw new HttpOperationError('busy', '结束当前传输后再修改设备。')
          const name = 'name' in value ? value.name : undefined
          if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 128))
            throw new HttpOperationError('invalid-request', '设备名称无效。')
          await library.device(value.id, value.action as 'block' | 'allow' | 'forget', name)
        } else {
          if (
            !('deviceId' in value) ||
            !isOpaqueId(value.deviceId) ||
            !('rootId' in value) ||
            !isOpaqueId(value.rootId) ||
            !('parentId' in value) ||
            (value.parentId !== null && !isOpaqueId(value.parentId)) ||
            Object.keys(value).length !== 3
          )
            throw new HttpOperationError('invalid-request', '目录请求无效。')
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
  return () => {
    for (const channel of Object.values(LIBRARY_CHANNELS)) ipc.removeHandler(channel)
  }
}
