import { isOpaqueId } from '../protocol/protocol.ts'
import { isDirectoryListing, isOperationError, isOperationResult } from '../protocol/validation.ts'
import { isSyncPlan } from '../sync/sync-plan-validation.ts'
import { hasShape, isOneOf, isRecord } from '../validation/data-validation.ts'
import type {
  ControlEventBodies,
  ControlEventMethod,
  ControlMessage,
  ControlRequestBodies,
  ControlRequestMethod,
  ControlResponseValues,
  RemoteSyncReport,
} from './control-contracts.ts'

const REQUESTS: readonly ControlRequestMethod[] = [
  'directory.list',
  'sync.prepare',
  'sync.confirm',
  'sync.cancel',
]
const EVENTS: readonly ControlEventMethod[] = ['catalog.changed', 'sync.report']

/** 只核对外层格式；请求体、应答值和事件体按方法另行校验。 */
export function isControlMessage(value: unknown): value is ControlMessage {
  if (!isRecord(value) || value.v !== 1) {
    return false
  }
  if (value.type === 'request') {
    return (
      hasShape(value, ['v', 'type', 'id', 'method', 'body']) &&
      isOpaqueId(value.id) &&
      isOneOf(value.method, REQUESTS)
    )
  }
  if (value.type === 'response') {
    return (
      hasShape(value, ['v', 'type', 'id', 'result']) &&
      isOpaqueId(value.id) &&
      isOperationResult(value.result, (item): item is unknown => item !== undefined)
    )
  }
  return (
    value.type === 'event' &&
    hasShape(value, ['v', 'type', 'method', 'body']) &&
    isOneOf(value.method, EVENTS)
  )
}
export function isControlRequestBody<M extends ControlRequestMethod>(
  method: M,
  value: unknown,
): value is ControlRequestBodies[M] {
  if (method === 'directory.list') {
    return (
      hasShape(value, ['rootId', 'parentId']) &&
      isOpaqueId(value.rootId) &&
      (value.parentId === null || isOpaqueId(value.parentId))
    )
  }
  if (method === 'sync.prepare') {
    return (
      hasShape(value, ['requestId', 'projectId', 'direction']) &&
      isOpaqueId(value.requestId) &&
      isOpaqueId(value.projectId) &&
      isOneOf(value.direction, ['android-to-windows', 'windows-to-android'])
    )
  }
  return hasShape(value, ['requestId']) && isOpaqueId(value.requestId)
}
export function isControlResponseValue<M extends ControlRequestMethod>(
  method: M,
  value: unknown,
): value is ControlResponseValues[M] {
  if (method === 'directory.list') {
    return isDirectoryListing(value)
  }
  if (method === 'sync.confirm') {
    return hasShape(value, ['jobId']) && isOpaqueId(value.jobId)
  }
  return value === null
}
/** 每种状态只允许对应字段；计划与项目的匹配由发起方另行核对。 */
export function isRemoteSyncReport(value: unknown): value is RemoteSyncReport {
  if (!isRecord(value) || !isOpaqueId(value.requestId)) {
    return false
  }
  if (value.status === 'preparing') {
    return hasShape(value, ['requestId', 'status'])
  }
  if (value.status === 'ready') {
    return hasShape(value, ['requestId', 'status', 'plan']) && isSyncPlan(value.plan)
  }
  if (value.status === 'failed') {
    return hasShape(value, ['requestId', 'status', 'error']) && isOperationError(value.error)
  }
  return (
    value.status === 'finished' &&
    hasShape(value, ['requestId', 'status', 'jobId', 'outcome', 'error']) &&
    isOpaqueId(value.jobId) &&
    isOneOf(value.outcome, ['succeeded', 'failed', 'cancelled', 'unknown']) &&
    (value.error === null || isOperationError(value.error))
  )
}
export function isControlEventBody<M extends ControlEventMethod>(
  method: M,
  value: unknown,
): value is ControlEventBodies[M] {
  return method === 'catalog.changed' ? hasShape(value, []) : isRemoteSyncReport(value)
}
