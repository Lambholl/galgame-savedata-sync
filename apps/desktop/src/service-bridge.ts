import {
  isBatchState,
  isDirectoryReference,
  isDirectorySelectionResult,
  isOpaqueId,
  isOperationError,
  isOperationResult,
} from '@savedata-sync/shared'
import type {
  BatchState,
  DirectoryReference,
  DirectorySelectionResult,
  OperationError,
  OperationResult,
} from '@savedata-sync/shared'

/** 服务快照只含公开元数据；地址用于手机手动连接，写授权仅在本进程有效。 */
export interface DesktopServiceSnapshot {
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
  stop: 'service:stop',
  chooseTarget: 'service:choose-target',
  revokeTarget: 'service:revoke-target',
  cancel: 'service:cancel',
  cleanup: 'service:cleanup',
} as const

/** 可信本机控制；所有失败 resolve 为脱敏错误，无路径、字节或通用 IPC。 */
export interface DesktopServiceApi {
  status(): Promise<OperationResult<DesktopServiceSnapshot>>
  start(port: number): Promise<OperationResult<DesktopServiceSnapshot>>
  stop(): Promise<OperationResult<DesktopServiceSnapshot>>
  chooseTarget(): Promise<DirectorySelectionResult>
  revokeTarget(rootId: string): Promise<OperationResult<DesktopServiceSnapshot>>
  cancel(transferId: string): Promise<OperationResult<DesktopServiceSnapshot>>
  retryCleanup(): Promise<OperationResult<DesktopServiceSnapshot>>
}

function isSnapshot(value: unknown): value is DesktopServiceSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('listener' in value) ||
    !('error' in value) ||
    !('targets' in value) ||
    !('tasks' in value)
  )
    return false
  const listener = value.listener
  return (
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
  return Object.freeze({
    status: () => call(SERVICE_CHANNELS.status),
    start: (port: number) =>
      Number.isInteger(port) && port >= 0 && port <= 65535
        ? call(SERVICE_CHANNELS.start, { port })
        : Promise.resolve(failure),
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
  })
}
