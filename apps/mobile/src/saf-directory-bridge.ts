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

/** 原生插件传输仅供绑定内部使用，不返回文件字节或 URI。 */
export interface SafNativePlugin {
  chooseDirectory(): Promise<unknown>
  listRoots(): Promise<unknown>
  listDirectory(options: { rootId: string; parentId: string | null }): Promise<unknown>
}

/** 前台元数据 API；Promise 返回已脱敏的结果，包括桥不可用的情况。 */
export interface AndroidDirectoryApi {
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
const UNSUPPORTED: OperationError = {
  code: 'unsupported-operation',
  message: '请在 Android 应用中使用系统目录选择器。',
  canRetry: false,
}

function isRootList(value: unknown): value is readonly DirectoryReference[] {
  return Array.isArray(value) && value.every(isDirectoryReference)
}

/**
 * 创建能力有限且已冻结的桥；校验两端数据，并将枚举结果绑定到请求。
 * 不创建订阅或持有原生流；提供者 I/O 和取消操作均由插件管理。
 */
export function createSafDirectoryBridge(
  plugin: SafNativePlugin,
  isAndroid: () => boolean,
): AndroidDirectoryApi {
  return Object.freeze({
    async chooseDirectory(): Promise<DirectorySelectionResult> {
      if (!isAndroid()) return { status: 'error', error: UNSUPPORTED }
      try {
        const result = await plugin.chooseDirectory()
        return isDirectorySelectionResult(result)
          ? result
          : { status: 'error', error: BRIDGE_ERROR }
      } catch {
        return { status: 'error', error: BRIDGE_ERROR }
      }
    },
    async listRoots(): Promise<OperationResult<readonly DirectoryReference[]>> {
      if (!isAndroid()) return { status: 'error', error: UNSUPPORTED }
      try {
        const result = await plugin.listRoots()
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
      if (!isAndroid()) return { status: 'error', error: UNSUPPORTED }
      try {
        const result = await plugin.listDirectory({ rootId, parentId })
        if (
          !isOperationResult(result, isDirectoryListing) ||
          (result.status === 'success' &&
            (result.value.rootId !== rootId || result.value.parentId !== parentId))
        ) {
          return { status: 'error', error: BRIDGE_ERROR }
        }
        return result
      } catch {
        return { status: 'error', error: BRIDGE_ERROR }
      }
    },
  })
}
