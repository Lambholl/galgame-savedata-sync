import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { isOpaqueId } from '@savedata-sync/shared'
import type { DirectorySelectionResult, OperationError } from '@savedata-sync/shared'
import { DIRECTORY_CHANNELS } from '../directory-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { toDirectoryError } from './directory-errors.ts'

/** 系统选择器只由主进程调用，null 为用户取消；可信判断须检查主 frame 与本地窗口。 */
export interface DirectoryIpcOptions {
  readonly choosePath: () => Promise<string | null>
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** 仅信任应用登记窗口的主 frame 和精确 renderer URL；子 frame 或导航后的页面拒绝。 */
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
    error: { code: 'invalid-request', message: '目录请求参数无效。', canRetry: false },
  }
}

/**
 * 注册三个有限 IPC；不接受页面提供的路径、写入方法或读流请求。
 * 返回函数负责移除 handler，窗口退出时由应用调用；选择取消不清空已保存目录。
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
      message: '不允许此页面访问本地目录。',
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
