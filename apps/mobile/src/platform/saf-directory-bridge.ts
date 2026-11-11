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

/** SAF 目录的原生插件；方法与 AndroidDirectoryApi 的同名方法对应，返回值未经校验。 */
export interface SafNativePlugin {
  chooseDirectory(): Promise<unknown>
  listRoots(): Promise<unknown>
  listDirectory(options: { rootId: string; parentId: string | null }): Promise<unknown>
}

/** 本机目录接口：选择、列出和浏览已登记的目录。所有方法的失败都以错误结果返回。 */
export interface AndroidDirectoryApi {
  /** 打开系统目录选择器，登记所选目录并申请持久读写权限。 */
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
  message: 'The directory service response is invalid or the connection failed.',
  canRetry: false,
}
const UNSUPPORTED: OperationError = {
  code: 'unsupported-operation',
  message: 'Use the system directory picker in the Android app.',
  canRetry: false,
}

function isRootList(value: unknown): value is readonly DirectoryReference[] {
  return Array.isArray(value) && value.every(isDirectoryReference)
}

/**
 * 用原生插件创建冻结的 AndroidDirectoryApi。
 *
 * @returns 参数无效、返回格式不对或结果与请求不符时，对应方法返回错误结果。
 */
export function createSafDirectoryBridge(
  plugin: SafNativePlugin,
  isAndroid: () => boolean,
): AndroidDirectoryApi {
  return Object.freeze({
    async chooseDirectory(): Promise<DirectorySelectionResult> {
      if (!isAndroid()) {
        return { status: 'error', error: UNSUPPORTED }
      }
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
      if (!isAndroid()) {
        return { status: 'error', error: UNSUPPORTED }
      }
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
          error: {
            code: 'invalid-request',
            message: 'The directory reference format is invalid.',
            canRetry: false,
          },
        }
      }
      if (!isAndroid()) {
        return { status: 'error', error: UNSUPPORTED }
      }
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
