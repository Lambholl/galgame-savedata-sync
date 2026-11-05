import {
  isDirectoryListing,
  isDirectoryReference,
  isDirectorySelectionResult,
  isOpaqueId,
  isOperationResult,
} from '@savedata-sync/shared'
import type {
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  OperationError,
  OperationResult,
} from '@savedata-sync/shared'

/** 目录功能的固定 IPC 通道名；网页只能调用这些通道，拿不到通用 invoke、文件路径或 Node 句柄。 */
export const DIRECTORY_CHANNELS = {
  choose: 'directories:choose',
  roots: 'directories:roots',
  list: 'directories:list',
} as const

/** 渲染进程使用的目录接口：选择、恢复和浏览目录。 */
export interface DesktopDirectoryApi {
  chooseDirectory(): Promise<DirectorySelectionResult>
  listRoots(): Promise<OperationResult<readonly DirectoryReference[]>>
  listDirectory(
    rootId: string,
    parentId?: string | null,
  ): Promise<OperationResult<DirectoryListing>>
}

const BRIDGE_ERROR: OperationError = {
  code: 'io-failure',
  message: '目录服务响应无效或连接失败。',
  canRetry: false,
}

function isRootList(value: unknown): value is readonly DirectoryReference[] {
  if (!Array.isArray(value)) {
    return false
  }
  for (const item of value) {
    if (!isDirectoryReference(item)) {
      return false
    }
  }
  return true
}

/**
 * 创建冻结的目录桥：校验 IPC 返回值和目录引用，传输失败时返回脱敏错误，不抛平台异常。
 * invoke 由 preload 提供，不能暴露给页面。
 */
export function createDirectoryBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopDirectoryApi {
  return Object.freeze({
    async chooseDirectory(): Promise<DirectorySelectionResult> {
      try {
        const result = await invoke(DIRECTORY_CHANNELS.choose)
        return isDirectorySelectionResult(result)
          ? result
          : { status: 'error', error: BRIDGE_ERROR }
      } catch {
        return { status: 'error', error: BRIDGE_ERROR }
      }
    },
    async listRoots(): Promise<OperationResult<readonly DirectoryReference[]>> {
      try {
        const result = await invoke(DIRECTORY_CHANNELS.roots)
        return isOperationResult(result, isRootList)
          ? result
          : { status: 'error', error: BRIDGE_ERROR }
      } catch {
        return { status: 'error', error: BRIDGE_ERROR }
      }
    },
    async listDirectory(
      rootId: string,
      parentId: string | null = null,
    ): Promise<OperationResult<DirectoryListing>> {
      if (!isOpaqueId(rootId) || (parentId !== null && !isOpaqueId(parentId))) {
        return {
          status: 'error',
          error: { code: 'invalid-request', message: '目录引用格式无效。', canRetry: false },
        }
      }
      try {
        const result = await invoke(DIRECTORY_CHANNELS.list, { rootId, parentId })
        return isOperationResult(result, isDirectoryListing)
          ? result
          : { status: 'error', error: BRIDGE_ERROR }
      } catch {
        return { status: 'error', error: BRIDGE_ERROR }
      }
    },
  })
}
