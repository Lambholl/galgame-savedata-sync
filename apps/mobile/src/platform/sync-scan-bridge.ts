import {
  SYNC_SCHEMA_VERSION,
  isOpaqueId,
  isOperationResult,
  isSyncCapabilities,
  isSyncScanState,
} from '@savedata-sync/shared'
import type { OperationResult, SyncCapabilities, SyncScanState } from '@savedata-sync/shared'

/** 有限原生接口，参数和结果只有公开 ID 与扫描元数据。 */
export interface SyncScanNativePlugin {
  capabilities(): Promise<unknown>
  start(options: { schemaVersion: typeof SYNC_SCHEMA_VERSION; rootId: string }): Promise<unknown>
  query(options: { scanId: string }): Promise<unknown>
  cancel(options: { scanId: string }): Promise<unknown>
}

/** Promise 均返回脱敏包络；原生层保存本次扫描状态和结果。 */
export interface AndroidSyncScanApi {
  capabilities(): Promise<OperationResult<SyncCapabilities>>
  start(rootId: string): Promise<OperationResult<SyncScanState>>
  query(scanId: string): Promise<OperationResult<SyncScanState>>
  cancel(scanId: string): Promise<OperationResult<SyncScanState>>
}

function failure(
  code: 'invalid-request' | 'unsupported-operation' | 'io-failure',
  message: string,
): OperationResult<never> {
  return { status: 'error', error: { code, message, canRetry: false } }
}

/**
 * 校验公开参数、原生结果和 Android 平台。
 * start 绑定 rootId，query/cancel 绑定 scanId；不支持浏览器模拟扫描或传递文件字节。
 */
export function createSyncScanBridge(
  plugin: SyncScanNativePlugin,
  isAndroid: () => boolean,
): AndroidSyncScanApi {
  async function invoke<T>(
    work: () => Promise<unknown>,
    guard: (value: unknown) => value is T,
  ): Promise<OperationResult<T>> {
    if (!isAndroid()) {
      return failure('unsupported-operation', '请在 Android 应用中扫描目录。')
    }
    try {
      const value = await work()
      return isOperationResult(value, guard)
        ? value
        : failure('io-failure', '原生扫描响应无效，请重新读取。')
    } catch {
      return failure('io-failure', '原生扫描服务不可用，请重新读取。')
    }
  }
  async function task(
    action: 'start' | 'query' | 'cancel',
    id: string,
  ): Promise<OperationResult<SyncScanState>> {
    if (!isOpaqueId(id)) {
      return failure('invalid-request', '扫描或目录引用无效。')
    }
    const value = await invoke(
      () =>
        action === 'start'
          ? plugin.start({ schemaVersion: SYNC_SCHEMA_VERSION, rootId: id })
          : plugin[action]({ scanId: id }),
      isSyncScanState,
    )
    if (
      value.status === 'success' &&
      value.value[action === 'start' ? 'rootId' : 'scanId'] !== id
    ) {
      return failure('io-failure', '扫描结果与本次请求不匹配。')
    }
    return value
  }
  return Object.freeze({
    capabilities: () => invoke(() => plugin.capabilities(), isSyncCapabilities),
    start: (rootId: string) => task('start', rootId),
    query: (scanId: string) => task('query', scanId),
    cancel: (scanId: string) => task('cancel', scanId),
  })
}
