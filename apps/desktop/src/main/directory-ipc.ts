import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isOpaqueId } from '@savedata-sync/shared'
import type { DirectorySelectionResult, OperationError } from '@savedata-sync/shared'
import { DIRECTORY_CHANNELS } from '../bridge/directory-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { toDirectoryError } from './directory-errors.ts'

/** 注册目录 IPC 的选项：系统选择器只由主进程调用，null 表示取消；可信判断要检查主 frame 和本地窗口。 */
export interface DirectoryIpcOptions {
  readonly choosePath: () => Promise<string | null>
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** 判断 IPC 发送方是否可信：必须是应用登记窗口的主 frame，URL 精确等于 renderer URL。子 frame 和导航后的页面都拒绝。 */
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
 * 注册三个目录 IPC 通道；页面不能传路径，也没有写入或读流通道。
 * 返回的函数负责移除 handler，窗口退出时由应用调用；取消选择时已保存的目录保留。
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
