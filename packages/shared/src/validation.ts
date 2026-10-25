import type {
  CapabilityState,
  CreateFileRequest,
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
  TransferProgress,
  TransferResult,
  TransferState,
} from './contracts.ts'
import {
  HTTP_ERROR_STATUS,
  isOpaqueId,
  isPortableFileName,
  isProtocolVersionSupported,
  isSha256,
} from './protocol.ts'

type ValueGuard<TValue> = (value: unknown) => value is TValue

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasShape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
}

function isNullable<TValue>(value: unknown, guard: ValueGuard<TValue>): value is TValue | null {
  return value === null || guard(value)
}

function isArrayOf<TValue>(value: unknown, guard: ValueGuard<TValue>): value is TValue[] {
  if (!Array.isArray(value)) return false
  // for...of 也检查稀疏数组中的空洞，避免 every 跳过缺失条目。
  for (const item of value) if (!guard(item)) return false
  return true
}

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
    (value.code !== 'result-unknown' || !value.canRetry)
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

function hasTransferIdentity(value: Record<string, unknown>): boolean {
  return (
    isOpaqueId(value.transferId) &&
    (value.direction === 'windows-to-android' || value.direction === 'android-to-windows')
  )
}

/** 校验运行阶段与字节边界；传满字节仍是 running，成功必须使用独立回执。 */
export function isTransferProgress(value: unknown): value is TransferProgress {
  return (
    hasShape(value, [
      'transferId',
      'direction',
      'status',
      'stage',
      'bytesTransferred',
      'totalBytes',
    ]) &&
    hasTransferIdentity(value) &&
    value.status === 'running' &&
    typeof value.stage === 'string' &&
    ['preparing', 'transferring', 'verifying', 'publishing'].includes(value.stage) &&
    isByteCount(value.bytesTransferred) &&
    isNullable(value.totalBytes, isByteCount) &&
    (value.totalBytes === null || value.bytesTransferred <= value.totalBytes)
  )
}

/** 校验成功/失败/取消/待确认的互斥结果；不会计算哈希或把未知解释为未写入。 */
export function isTransferResult(value: unknown): value is TransferResult {
  if (!isRecord(value)) return false
  switch (value.status) {
    case 'succeeded':
      return (
        hasShape(value, [
          'transferId',
          'direction',
          'status',
          'bytesTransferred',
          'sha256',
          'entry',
        ]) &&
        hasTransferIdentity(value) &&
        isByteCount(value.bytesTransferred) &&
        isSha256(value.sha256) &&
        isEntryMetadata(value.entry) &&
        value.entry.kind === 'file' &&
        (value.entry.sizeBytes === null || value.entry.sizeBytes === value.bytesTransferred)
      )
    case 'failed':
      return (
        hasShape(value, ['transferId', 'direction', 'status', 'error', 'residualEntry']) &&
        hasTransferIdentity(value) &&
        isOperationError(value.error) &&
        value.error.code !== 'result-unknown' &&
        isNullable(value.residualEntry, isEntryReference)
      )
    case 'cancelled':
      return (
        hasShape(value, ['transferId', 'direction', 'status', 'residualEntry']) &&
        hasTransferIdentity(value) &&
        isNullable(value.residualEntry, isEntryReference)
      )
    case 'unknown':
      return (
        hasShape(value, ['transferId', 'direction', 'status', 'error']) &&
        hasTransferIdentity(value) &&
        isOperationError(value.error) &&
        value.error.code === 'result-unknown'
      )
    default:
      return false
  }
}

/** 校验会话内查询观察；运行态和结果态共享身份但不可混合字段。 */
export function isTransferState(value: unknown): value is TransferState {
  return isTransferProgress(value) || isTransferResult(value)
}

/** 校验新文件请求元数据，不打开流；实际同名冲突、能力和发布竞争由平台处理。 */
export function isCreateFileRequest(value: unknown): value is CreateFileRequest {
  return (
    hasShape(value, [
      'rootId',
      'parentId',
      'transferId',
      'name',
      'expectedSizeBytes',
      'expectedSha256',
    ]) &&
    isOpaqueId(value.rootId) &&
    isNullable(value.parentId, isOpaqueId) &&
    isOpaqueId(value.transferId) &&
    isPortableFileName(value.name) &&
    isNullable(value.expectedSizeBytes, isByteCount) &&
    isSha256(value.expectedSha256)
  )
}
