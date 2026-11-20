import type { BatchDeviceDescriptor, BatchLimits } from './batch-contracts.ts'
import { BATCH_LIMITS } from './batch-limits.ts'
import { hasShape } from '../validation/data-validation.ts'
import { isOpaqueId } from './protocol.ts'
import { isDeviceDescriptor } from './validation.ts'

/** 校验固定上限：每个字段都与 BATCH_LIMITS 相等。 */
export function isBatchLimits(value: unknown): value is BatchLimits {
  return (
    hasShape(value, Object.keys(BATCH_LIMITS)) &&
    Object.entries(BATCH_LIMITS).every(([key, limit]) => value[key] === limit)
  )
}

/** 校验 HTTP 设备描述。 */
export function isBatchDeviceDescriptor(value: unknown): value is BatchDeviceDescriptor {
  return (
    hasShape(value, ['device', 'sessionId', 'limits']) &&
    isDeviceDescriptor(value.device) &&
    isOpaqueId(value.sessionId) &&
    isBatchLimits(value.limits)
  )
}
