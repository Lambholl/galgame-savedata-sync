import type {
  CapabilityState,
  DeviceCapabilities,
  DeviceDescriptor,
  DirectoryListing,
  DirectoryReference,
  DirectorySelectionResult,
  EntryCapabilities,
  EntryMetadata,
  EntryReference,
  OperationError,
  OperationResult,
} from './contracts.ts'
import { HTTP_ERROR_STATUS, isOpaqueId, isProtocolVersionSupported } from './protocol.ts'

import {
  hasShape,
  isText,
  isByteCount,
  isTimestamp,
  isNullable,
  isArrayOf,
} from './data-validation.ts'
import type { ValueGuard } from './data-validation.ts'

function isCapability(value: unknown): value is CapabilityState {
  return value === 'supported' || value === 'unsupported' || value === 'unknown'
}

function isEntryCapabilities(value: unknown): value is EntryCapabilities {
  return (
    hasShape(value, ['canRead', 'canList', 'canCreate', 'canRename', 'canDelete']) &&
    Object.values(value).every(isCapability)
  )
}

function isDeviceCapabilities(value: unknown): value is DeviceCapabilities {
  return (
    hasShape(value, [
      'canListRoots',
      'canReadFiles',
      'canReceiveFiles',
      'canQueryTransfers',
      'canCancelTransfers',
    ]) && Object.values(value).every(isCapability)
  )
}

/** 校验解析后的 JSON 设备描述与确切版本；不请求网络、不保存或改变输入。 */
export function isDeviceDescriptor(value: unknown): value is DeviceDescriptor {
  return (
    hasShape(value, ['protocolVersion', 'deviceId', 'displayName', 'platform', 'capabilities']) &&
    isProtocolVersionSupported(value.protocolVersion) &&
    isOpaqueId(value.deviceId) &&
    isText(value.displayName) &&
    (value.platform === 'windows' || value.platform === 'android') &&
    isDeviceCapabilities(value.capabilities)
  )
}

/** 校验公开目录引用；不接受额外路径字段，不代表实际持久授权仍有效。 */
export function isDirectoryReference(value: unknown): value is DirectoryReference {
  return (
    hasShape(value, ['rootId', 'deviceId', 'displayName', 'authorization']) &&
    isOpaqueId(value.rootId) &&
    isOpaqueId(value.deviceId) &&
    isText(value.displayName) &&
    typeof value.authorization === 'string' &&
    ['granted', 'expired', 'unavailable', 'unverified'].includes(value.authorization)
  )
}

/** 验证根内的不透明引用；访问权限和根内真实路径仍需平台适配器确认。 */
export function isEntryReference(value: unknown): value is EntryReference {
  return (
    hasShape(value, ['rootId', 'entryId']) && isOpaqueId(value.rootId) && isOpaqueId(value.entryId)
  )
}

/** 校验元数据快照；未知保留 null，目录拒绝汇总大小，不执行实际文件读取。 */
export function isEntryMetadata(value: unknown): value is EntryMetadata {
  return (
    hasShape(value, [
      'rootId',
      'entryId',
      'parentId',
      'name',
      'kind',
      'sizeBytes',
      'modifiedAt',
      'capabilities',
    ]) &&
    isOpaqueId(value.rootId) &&
    isOpaqueId(value.entryId) &&
    isNullable(value.parentId, isOpaqueId) &&
    value.parentId !== value.entryId &&
    isText(value.name) &&
    isNullable(value.modifiedAt, isTimestamp) &&
    isEntryCapabilities(value.capabilities) &&
    ((value.kind === 'file' && isNullable(value.sizeBytes, isByteCount)) ||
      (value.kind === 'directory' && value.sizeBytes === null))
  )
}

/** 校验当前层成功结果；拒绝重复引用或混入其他根/层的条目，空数组合法。 */
export function isDirectoryListing(value: unknown): value is DirectoryListing {
  if (
    !hasShape(value, ['rootId', 'parentId', 'observedAt', 'entries']) ||
    !isOpaqueId(value.rootId) ||
    !isNullable(value.parentId, isOpaqueId) ||
    !isTimestamp(value.observedAt) ||
    !isArrayOf(value.entries, isEntryMetadata)
  ) {
    return false
  }
  return (
    value.entries.every(
      (entry) => entry.rootId === value.rootId && entry.parentId === value.parentId,
    ) && new Set(value.entries.map((entry) => entry.entryId)).size === value.entries.length
  )
}

/** 校验错误包络字段；结果未知禁止声明可直接重试，错误消息脱敏由生产者负责。 */
export function isOperationError(value: unknown): value is OperationError {
  return (
    hasShape(value, ['code', 'message', 'canRetry']) &&
    typeof value.code === 'string' &&
    Object.hasOwn(HTTP_ERROR_STATUS, value.code) &&
    isText(value.message) &&
    typeof value.canRetry === 'boolean' &&
    (!['result-unknown', 'session-mismatch'].includes(value.code) || !value.canRetry)
  )
}

/** 以调用者提供的纯值守卫校验互斥包络；不克隆/冻结对象，消费方不应修改快照。 */
export function isOperationResult<TValue>(
  value: unknown,
  guard: ValueGuard<TValue>,
): value is OperationResult<TValue> {
  return (
    (hasShape(value, ['status', 'value']) && value.status === 'success' && guard(value.value)) ||
    (hasShape(value, ['status', 'error']) &&
      value.status === 'error' &&
      isOperationError(value.error))
  )
}

/** 选择取消是独立结果，不能带目录或错误，也不隐式撤销已保存目录。 */
export function isDirectorySelectionResult(value: unknown): value is DirectorySelectionResult {
  return (
    (hasShape(value, ['status', 'directory']) &&
      value.status === 'selected' &&
      isDirectoryReference(value.directory)) ||
    (hasShape(value, ['status']) && value.status === 'cancelled') ||
    (hasShape(value, ['status', 'error']) &&
      value.status === 'error' &&
      isOperationError(value.error))
  )
}
