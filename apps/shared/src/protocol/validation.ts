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
  isRecord,
  isText,
  isByteCount,
  isTimestamp,
  isNullable,
  isArrayOf,
} from '../validation/data-validation.ts'
import type { ValueGuard } from '../validation/data-validation.ts'

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

/** 校验解析后的 JSON 设备描述和协议版本。 */
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

/** 校验目录引用和可选的展示信息。 */
export function isDirectoryReference(value: unknown): value is DirectoryReference {
  if (!isRecord(value)) {
    return false
  }
  return (
    hasShape(value, [
      'rootId',
      'deviceId',
      'displayName',
      'authorization',
      ...(Object.hasOwn(value, 'displayPath') ? ['displayPath'] : []),
      ...(Object.hasOwn(value, 'parentName') ? ['parentName'] : []),
    ]) &&
    isOpaqueId(value.rootId) &&
    isOpaqueId(value.deviceId) &&
    isText(value.displayName) &&
    (!Object.hasOwn(value, 'displayPath') || isText(value.displayPath)) &&
    (!Object.hasOwn(value, 'parentName') || isText(value.parentName)) &&
    typeof value.authorization === 'string' &&
    ['granted', 'expired', 'unavailable', 'unverified'].includes(value.authorization)
  )
}

/** 校验根目录内的不透明条目引用。 */
export function isEntryReference(value: unknown): value is EntryReference {
  return (
    hasShape(value, ['rootId', 'entryId']) && isOpaqueId(value.rootId) && isOpaqueId(value.entryId)
  )
}

/** 校验元数据快照：未知值为 null，文件夹的 sizeBytes 必须为 null。 */
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

/** 校验一层目录的列表：条目引用互不重复，且都属于同一根目录和同一层；空数组合法。 */
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

/** 校验错误字段；result-unknown 的 canRetry 必须为 false。 */
export function isOperationError(value: unknown): value is OperationError {
  return (
    (hasShape(value, ['code', 'message', 'canRetry']) ||
      (hasShape(value, ['code', 'message', 'canRetry', 'device']) &&
        (value.device === 'phone' || value.device === 'pc'))) &&
    typeof value.code === 'string' &&
    Object.hasOwn(HTTP_ERROR_STATUS, value.code) &&
    isText(value.message) &&
    typeof value.canRetry === 'boolean' &&
    (!['result-unknown', 'session-mismatch'].includes(value.code) || !value.canRetry)
  )
}

/**
 * 校验 OperationResult 包络，成功值用 guard 校验。
 *
 * @returns 通过校验时，value 是传入的同一个对象。
 */
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

/** 校验目录选择结果：cancelled 不带目录或错误。 */
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
