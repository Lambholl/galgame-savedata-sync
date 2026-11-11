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

/** 目录接口的 IPC 通道名。 */
export const DIRECTORY_CHANNELS = {
  choose: 'directories:choose',
  roots: 'directories:roots',
  list: 'directories:list',
} as const

/** 本机目录接口：选择、列出和浏览已登记的目录。 */
export interface DesktopDirectoryApi {
  /** 打开系统目录选择器并登记所选目录。 */
  chooseDirectory(): Promise<DirectorySelectionResult>
  /** 列出已登记的根目录。 */
  listRoots(): Promise<OperationResult<readonly DirectoryReference[]>>
  /** 列出根目录内的一层；parentId 省略或为 null 时列根层。 */
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
 * 用 invoke 创建冻结的 DesktopDirectoryApi。
 *
 * @returns invoke 失败或返回格式不对时，对应方法返回 io-failure 错误结果。
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
