import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isOpaqueId } from '@savedata-sync/shared'
import type { DirectorySelectionResult, OperationError } from '@savedata-sync/shared'
import { DIRECTORY_CHANNELS } from '../bridge/directory-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { toDirectoryError } from './directory-errors.ts'

/** 注册目录 IPC 的选项：choosePath 返回 null 表示取消选择。 */
export interface DirectoryIpcOptions {
  readonly choosePath: () => Promise<string | null>
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** 判断 IPC 发送方是否可信：发送方是 trustedWindows 里窗口的主 frame，且 URL 等于 expectedUrl。 */
export function isTrustedDirectorySender(
  event: IpcMainInvokeEvent,
  trustedWindows: ReadonlySet<number>,
  expectedUrl: string,
): boolean {
  return (
    trustedWindows.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === expectedUrl
  )
}

function invalidRequest(): { status: 'error'; error: OperationError } {
  return {
    status: 'error',
    error: {
      code: 'invalid-request',
      message: 'Directory request parameters are invalid.',
      canRetry: false,
    },
  }
}

/**
 * 注册目录接口的 IPC 处理函数；isTrustedSender 不通过的调用返回错误。
 *
 * @returns 移除这些处理函数的函数。
 */
export function registerDirectoryIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  adapter: WindowsDirectoryAdapter,
  options: DirectoryIpcOptions,
): () => void {
  const isAllowed = (event: IpcMainInvokeEvent): boolean => options.isTrustedSender(event)
  const forbidden = {
    status: 'error' as const,
    error: {
      code: 'permission-denied' as const,
      message: 'This page is not allowed to access local directories.',
      canRetry: false,
    },
  }
  ipc.handle(
    DIRECTORY_CHANNELS.choose,
    async (event, ...args: unknown[]): Promise<DirectorySelectionResult> => {
      if (!isAllowed(event)) {
        return forbidden
      }
      if (args.length !== 0) {
        return invalidRequest()
      }
      try {
        const path = await options.choosePath()
        if (!isAllowed(event)) {
          return forbidden
        }
        if (path === null) {
          return { status: 'cancelled' }
        }
        const result = await adapter.registerDirectory(path)
        return result.status === 'success'
          ? { status: 'selected', directory: result.value }
          : result
      } catch (error) {
        return { status: 'error', error: toDirectoryError(error).operationError }
      }
    },
  )
  ipc.handle(DIRECTORY_CHANNELS.roots, (event, ...args: unknown[]) => {
    if (!isAllowed(event)) {
      return forbidden
    }
    if (args.length !== 0) {
      return invalidRequest()
    }
    return adapter.listRoots()
  })
  ipc.handle(DIRECTORY_CHANNELS.list, (event, ...args: unknown[]) => {
    if (!isAllowed(event)) {
      return forbidden
    }
    const request: unknown = args[0]
    if (
      args.length !== 1 ||
      typeof request !== 'object' ||
      request === null ||
      Object.keys(request).length !== 2 ||
      !('rootId' in request) ||
      !Object.hasOwn(request, 'rootId') ||
      !('parentId' in request) ||
      !Object.hasOwn(request, 'parentId') ||
      !isOpaqueId(request.rootId) ||
      (request.parentId !== null && !isOpaqueId(request.parentId))
    ) {
      return invalidRequest()
    }
    return adapter.listDirectory(request.rootId, request.parentId)
  })
  return () => {
    for (const channel of Object.values(DIRECTORY_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
