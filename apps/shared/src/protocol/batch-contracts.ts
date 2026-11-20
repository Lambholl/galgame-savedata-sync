import type { DeviceDescriptor, OperationError } from './contracts.ts'

/** 除 result-unknown 以外、已确定原因的错误。 */
export type KnownOperationError = Exclude<OperationError, { readonly code: 'result-unknown' }>

/** 单批和会话的固定上限，两端相同。 */
export interface BatchLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalFileBytes: number
  readonly maxTarBytes: number
  readonly maxArchiveBytes: number
  readonly maxJsonBytes: number
  readonly maxConcurrentBatches: number
  readonly maxTransfersPerSession: number
}

/** HTTP 返回的设备信息：设备描述、会话 ID 和固定上限。sessionId 随服务重启变化，deviceId 保持不变。 */
export interface BatchDeviceDescriptor {
  readonly device: DeviceDescriptor
  readonly sessionId: string
  readonly limits: BatchLimits
}
