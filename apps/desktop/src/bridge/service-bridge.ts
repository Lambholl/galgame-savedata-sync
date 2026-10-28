import {
  isBatchState,
  isDirectoryReference,
  isDirectorySelectionResult,
  isOpaqueId,
  isOperationError,
  isOperationResult,
  isSyncScanState,
} from '@savedata-sync/shared'
import type {
  BatchState,
  DirectoryReference,
  DirectorySelectionResult,
  OperationError,
  OperationResult,
  SyncScanState,
} from '@savedata-sync/shared'

/** 服务快照只含公开元数据；地址用于手机手动连接，写授权仅在本进程有效。 */
export interface DesktopServiceSnapshot {
  readonly configuredPort: number
  readonly listener: {
    readonly host: string
    readonly port: number
    readonly addresses: readonly string[]
  } | null
  readonly error: OperationError | null
  readonly targets: readonly DirectoryReference[]
  readonly tasks: readonly BatchState[]
}

export const SERVICE_CHANNELS = {
  status: 'service:status',
  start: 'service:start',
  randomizePort: 'service:randomize-port',
  stop: 'service:stop',
  chooseTarget: 'service:choose-target',
  revokeTarget: 'service:revoke-target',
  cancel: 'service:cancel',
  cleanup: 'service:cleanup',
  scanStart: 'service:scan-start',
  scanQuery: 'service:scan-query',
  scanCancel: 'service:scan-cancel',
} as const

/** 可信本机控制；所有失败 resolve 为脱敏错误，无路径、字节或通用 IPC。 */
export interface DesktopServiceApi {
  status(): Promise<OperationResult<DesktopServiceSnapshot>>
  start(port: number): Promise<OperationResult<DesktopServiceSnapshot>>
  randomizePort(): Promise<OperationResult<DesktopServiceSnapshot>>
  stop(): Promise<OperationResult<DesktopServiceSnapshot>>
  chooseTarget(): Promise<DirectorySelectionResult>
  revokeTarget(rootId: string): Promise<OperationResult<DesktopServiceSnapshot>>
  cancel(transferId: string): Promise<OperationResult<DesktopServiceSnapshot>>
  retryCleanup(): Promise<OperationResult<DesktopServiceSnapshot>>
  startScan(rootId: string): Promise<OperationResult<SyncScanState>>
  queryScan(scanId: string): Promise<OperationResult<SyncScanState>>
  cancelScan(scanId: string): Promise<OperationResult<SyncScanState>>
}

function isSnapshot(value: unknown): value is DesktopServiceSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('configuredPort' in value) ||
    !('listener' in value) ||
    !('error' in value) ||
    !('targets' in value) ||
    !('tasks' in value)
  ) {
    return false
  }
  const listener = value.listener
  return (
    typeof value.configuredPort === 'number' &&
    Number.isInteger(value.configuredPort) &&
    value.configuredPort >= 1 &&
    value.configuredPort <= 65535 &&
    (listener === null ||
      (typeof listener === 'object' &&
        'host' in listener &&
        typeof listener.host === 'string' &&
        'port' in listener &&
        typeof listener.port === 'number' &&
        Number.isInteger(listener.port) &&
        listener.port > 0 &&
        listener.port <= 65535 &&
        'addresses' in listener &&
        Array.isArray(listener.addresses) &&
        listener.addresses.every((item: unknown) => typeof item === 'string'))) &&
    (value.error === null || isOperationError(value.error)) &&
    Array.isArray(value.targets) &&
    value.targets.every(isDirectoryReference) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isBatchState)
  )
}

/** preload 内部创建冻结桥；无订阅句柄，界面自行停止轮询。 */
export function createServiceBridge(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): DesktopServiceApi {
  const failure = {
    status: 'error' as const,
    error: {
      code: 'io-failure' as const,
      message: '本地服务响应无效，请重新读取状态。',
      canRetry: false,
    },
  }
  async function call(
    channel: string,
    ...args: unknown[]
  ): Promise<OperationResult<DesktopServiceSnapshot>> {
    try {
      const result = await invoke(channel, ...args)
      return isOperationResult(result, isSnapshot) ? result : failure
    } catch {
      return failure
    }
  }
  async function scanCall(
    channel: string,
    key: 'rootId' | 'scanId',
    id: string,
  ): Promise<OperationResult<SyncScanState>> {
    if (!isOpaqueId(id)) {
      return failure
    }
    try {
      const result = await invoke(channel, { [key]: id })
      if (
        !isOperationResult(result, isSyncScanState) ||
        (result.status === 'success' && result.value[key] !== id)
      ) {
        return failure
      }
      return result
    } catch {
      return failure
    }
  }
  return Object.freeze({
    status: () => call(SERVICE_CHANNELS.status),
    start: (port: number) =>
      Number.isInteger(port) && port >= 1 && port <= 65535
        ? call(SERVICE_CHANNELS.start, { port })
        : Promise.resolve(failure),
    randomizePort: () => call(SERVICE_CHANNELS.randomizePort),
    stop: () => call(SERVICE_CHANNELS.stop),
    async chooseTarget(): Promise<DirectorySelectionResult> {
      try {
        const result = await invoke(SERVICE_CHANNELS.chooseTarget)
        return isDirectorySelectionResult(result) ? result : failure
      } catch {
        return failure
      }
    },
    revokeTarget: (rootId: string) =>
      isOpaqueId(rootId)
        ? call(SERVICE_CHANNELS.revokeTarget, { rootId })
        : Promise.resolve(failure),
    cancel: (transferId: string) =>
      isOpaqueId(transferId)
        ? call(SERVICE_CHANNELS.cancel, { transferId })
        : Promise.resolve(failure),
    retryCleanup: () => call(SERVICE_CHANNELS.cleanup),
    startScan: (rootId: string) => scanCall(SERVICE_CHANNELS.scanStart, 'rootId', rootId),
    queryScan: (scanId: string) => scanCall(SERVICE_CHANNELS.scanQuery, 'scanId', scanId),
    cancelScan: (scanId: string) => scanCall(SERVICE_CHANNELS.scanCancel, 'scanId', scanId),
  })
}
