import { isOpaqueId } from '@savedata-sync/shared'
import type { DirectorySelectionResult, OperationError } from '@savedata-sync/shared'
import { DIRECTORY_CHANNELS } from '../bridge/directory-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { toDirectoryError } from './directory-errors.ts'
import type { ChannelRegistry } from './channel-registry.ts'

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
 * 注册目录接口的通道处理函数。
 *
 * @param choosePath 打开系统目录选择器，返回选中的绝对路径；取消时返回 null。
 * @returns 移除这些处理函数的函数。
 */
export function registerDirectoryIpc(
  ipc: ChannelRegistry,
  adapter: WindowsDirectoryAdapter,
  choosePath: () => Promise<string | null>,
): () => void {
  ipc.handle(
    DIRECTORY_CHANNELS.choose,
    async (...args: unknown[]): Promise<DirectorySelectionResult> => {
      if (args.length !== 0) {
        return invalidRequest()
      }
      try {
        const path = await choosePath()
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
  ipc.handle(DIRECTORY_CHANNELS.roots, (...args: unknown[]) => {
    if (args.length !== 0) {
      return invalidRequest()
    }
    return adapter.listRoots()
  })
  ipc.handle(DIRECTORY_CHANNELS.list, (...args: unknown[]) => {
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
