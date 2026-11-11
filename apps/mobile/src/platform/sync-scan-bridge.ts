import {
  SYNC_SCHEMA_VERSION,
  isOpaqueId,
  isOperationResult,
  isSyncCapabilities,
  isSyncScanState,
} from '@savedata-sync/shared'
import type { OperationResult, SyncCapabilities, SyncScanState } from '@savedata-sync/shared'

/** 扫描的原生插件；方法与 AndroidSyncScanApi 的同名方法对应，返回值未经校验。 */
export interface SyncScanNativePlugin {
  capabilities(): Promise<unknown>
  start(options: { schemaVersion: typeof SYNC_SCHEMA_VERSION; rootId: string }): Promise<unknown>
  query(options: { scanId: string }): Promise<unknown>
  cancel(options: { scanId: string }): Promise<unknown>
}

/** 本机目录扫描接口。所有方法的失败都以错误结果返回。 */
export interface AndroidSyncScanApi {
  /** 读取本机支持的复制能力。 */
  capabilities(): Promise<OperationResult<SyncCapabilities>>
  /** 开始扫描一个本机根目录。 */
  start(rootId: string): Promise<OperationResult<SyncScanState>>
  /** 读取扫描状态。 */
  query(scanId: string): Promise<OperationResult<SyncScanState>>
  /** 取消扫描。 */
  cancel(scanId: string): Promise<OperationResult<SyncScanState>>
}

function failure(
  code: 'invalid-request' | 'unsupported-operation' | 'io-failure',
  message: string,
): OperationResult<never> {
  return { status: 'error', error: { code, message, canRetry: false } }
}

/**
 * 用原生插件创建 AndroidSyncScanApi。
 *
 * @returns 不在 Android 上运行、参数无效、返回格式不对，或结果的 rootId、scanId 与请求不符时，对应方法返回错误结果。
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
      return failure('unsupported-operation', 'Scan directories in the Android app.')
    }
    try {
      const value = await work()
      return isOperationResult(value, guard)
        ? value
        : failure('io-failure', 'The native scan response is invalid. Read it again.')
    } catch {
      return failure('io-failure', 'The native scan service is unavailable. Read it again.')
    }
  }
  async function task(
    action: 'start' | 'query' | 'cancel',
    id: string,
  ): Promise<OperationResult<SyncScanState>> {
    if (!isOpaqueId(id)) {
      return failure('invalid-request', 'The scan or directory reference is invalid.')
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
      return failure('io-failure', 'The scan result does not match this request.')
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
