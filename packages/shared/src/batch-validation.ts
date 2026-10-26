import type {
  ArchiveDescriptor,
  BatchDeviceDescriptor,
  BatchLimits,
  BatchManifest,
  BatchProgress,
  BatchState,
  DownloadBatchRequest,
  FileOutcome,
  PreparedFile,
  ReceiveBatchRequest,
  SourceSelection,
  TargetSelection,
} from './batch-contracts.ts'
import type { EntryReference } from './contracts.ts'
import { BATCH_ARCHIVE, BATCH_LIMITS, isBatchFileId } from './batch-limits.ts'
import {
  hasShape,
  isArrayOf,
  isByteCount,
  isNullable,
  isRecord,
  isText,
  isTimestamp,
  isOneOf,
} from './data-validation.ts'
import type { ValueGuard } from './data-validation.ts'
import { isOpaqueId, isPortableFileName, isProtocolVersionSupported, isSha256 } from './protocol.ts'
import {
  isDeviceDescriptor,
  isEntryMetadata,
  isEntryReference,
  isOperationError,
} from './validation.ts'

function isBoundedCount(value: unknown, maximum: number): value is number {
  return isByteCount(value) && value <= maximum
}

function isBoundedArray<TValue>(
  value: unknown,
  guard: ValueGuard<TValue>,
  allowEmpty = false,
): value is TValue[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= BATCH_LIMITS.maxFiles &&
    isArrayOf(value, guard)
  )
}

function hasOrderedFileIds(files: readonly { readonly fileId: string }[]): boolean {
  return files.every((file, index) => file.fileId === `f${String(index + 1).padStart(6, '0')}`)
}

function hasUniqueReferences(entries: readonly EntryReference[]): boolean {
  return new Set(entries.map((entry) => `${entry.rootId}/${entry.entryId}`)).size === entries.length
}

/** 固定预算须逐字段精确一致，不接受由请求放宽上限；无 IO 副作用。 */
export function isBatchLimits(value: unknown): value is BatchLimits {
  return (
    hasShape(value, Object.keys(BATCH_LIMITS)) &&
    Object.entries(BATCH_LIMITS).every(([key, limit]) => value[key] === limit)
  )
}

/** HTTP 描述包装本地设备 DTO；会话仅表示当前服务实例，不是认证。 */
export function isBatchDeviceDescriptor(value: unknown): value is BatchDeviceDescriptor {
  return (
    hasShape(value, ['device', 'sessionId', 'limits']) &&
    isDeviceDescriptor(value.device) &&
    isOpaqueId(value.sessionId) &&
    isBatchLimits(value.limits)
  )
}

/** 选择项只含批内 fileId 和源引用；实际文件类型和根内身份由平台核实。 */
export function isSourceSelection(value: unknown): value is SourceSelection {
  return (
    hasShape(value, ['fileId', 'entryId']) &&
    isBatchFileId(value.fileId) &&
    isOpaqueId(value.entryId)
  )
}

/** 下载请求拒绝空批、稀疏数组、乱序编号及重复源引用；不展开目录。 */
export function isDownloadBatchRequest(value: unknown): value is DownloadBatchRequest {
  return (
    hasShape(value, ['protocolVersion', 'transferId', 'sourceRootId', 'files']) &&
    isProtocolVersionSupported(value.protocolVersion) &&
    isOpaqueId(value.transferId) &&
    isOpaqueId(value.sourceRootId) &&
    isBoundedArray(value.files, isSourceSelection) &&
    hasOrderedFileIds(value.files) &&
    new Set(value.files.map((file) => file.entryId)).size === value.files.length
  )
}

/** 已准备文件必须有实测长度/哈希；不把未知长度、日期或源路径强制转换。 */
export function isPreparedFile(value: unknown): value is PreparedFile {
  return (
    hasShape(value, [
      'fileId',
      'sourceEntryId',
      'sourceParentId',
      'sourceName',
      'sourceModifiedAt',
      'sizeBytes',
      'sha256',
    ]) &&
    isBatchFileId(value.fileId) &&
    isOpaqueId(value.sourceEntryId) &&
    isNullable(value.sourceParentId, isOpaqueId) &&
    value.sourceEntryId !== value.sourceParentId &&
    isText(value.sourceName) &&
    isNullable(value.sourceModifiedAt, isTimestamp) &&
    isBoundedCount(value.sizeBytes, BATCH_LIMITS.maxFileBytes) &&
    isSha256(value.sha256)
  )
}

/** 仅检查受限格式声明与字节预算，不实际解码、计算哈希或推断压缩级别。 */
export function isArchiveDescriptor(value: unknown): value is ArchiveDescriptor {
  return (
    hasShape(value, ['format', 'compressionLevel', 'sizeBytes', 'tarSizeBytes', 'sha256']) &&
    value.format === BATCH_ARCHIVE.format &&
    value.compressionLevel === BATCH_ARCHIVE.compressionLevel &&
    isBoundedCount(value.sizeBytes, BATCH_LIMITS.maxArchiveBytes) &&
    value.sizeBytes > 0 &&
    isBoundedCount(value.tarSizeBytes, BATCH_LIMITS.maxTarBytes) &&
    value.tarSizeBytes >= 1536 &&
    value.tarSizeBytes % BATCH_ARCHIVE.tarBlockBytes === 0 &&
    isSha256(value.sha256)
  )
}

/** 校验本次清单的编号、源唯一性、原文求和及精确 tar 头/填充/结束长度。 */
export function isBatchManifest(value: unknown): value is BatchManifest {
  if (
    !hasShape(value, [
      'protocolVersion',
      'transferId',
      'sourceDeviceId',
      'sourceRootId',
      'files',
      'totalFileBytes',
      'archive',
    ]) ||
    !isProtocolVersionSupported(value.protocolVersion) ||
    !isOpaqueId(value.transferId) ||
    !isOpaqueId(value.sourceDeviceId) ||
    !isOpaqueId(value.sourceRootId) ||
    !isBoundedArray(value.files, isPreparedFile) ||
    !hasOrderedFileIds(value.files) ||
    !isBoundedCount(value.totalFileBytes, BATCH_LIMITS.maxTotalFileBytes) ||
    !isArchiveDescriptor(value.archive)
  )
    return false
  const totalFileBytes = value.files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const tarSizeBytes = value.files.reduce(
    (sum, file) => sum + 512 + Math.ceil(file.sizeBytes / 512) * 512,
    1024,
  )
  return (
    value.totalFileBytes === totalFileBytes &&
    value.archive.tarSizeBytes === tarSizeBytes &&
    new Set(value.files.map((file) => file.sourceEntryId)).size === value.files.length
  )
}

/** 目标为已存在父目录引用和单文件名；不允许路径或隐式改名。 */
export function isTargetSelection(value: unknown): value is TargetSelection {
  return (
    hasShape(value, ['fileId', 'parentId', 'name']) &&
    isBatchFileId(value.fileId) &&
    isNullable(value.parentId, isOpaqueId) &&
    isPortableFileName(value.name)
  )
}

/** 校验清单/目标一一对应及显式同名冲突；平台仍须检查大小写/提供者等价和身份。 */
export function isReceiveBatchRequest(value: unknown): value is ReceiveBatchRequest {
  if (
    !hasShape(value, ['protocolVersion', 'manifest', 'targetRootId', 'targets']) ||
    !isProtocolVersionSupported(value.protocolVersion) ||
    !isBatchManifest(value.manifest) ||
    !isOpaqueId(value.targetRootId) ||
    !isBoundedArray(value.targets, isTargetSelection) ||
    value.targets.length !== value.manifest.files.length
  )
    return false
  const ids = new Set(value.targets.map((target) => target.fileId))
  const locations = new Set(
    value.targets.map((target) => JSON.stringify([target.parentId, target.name])),
  )
  return (
    ids.size === value.targets.length &&
    locations.size === value.targets.length &&
    value.manifest.files.every((file) => ids.has(file.fileId))
  )
}

/** 进度只计对应阶段的实际字节；不验证前一快照或平台操作真实性。 */
export function isBatchProgress(value: unknown): value is BatchProgress {
  if (
    !hasShape(value, [
      'sourceBytesRead',
      'archiveBytesTransferred',
      'fileBytesVerified',
      'fileBytesPublished',
      'totalFileBytes',
      'totalArchiveBytes',
      'totalFiles',
      'verifiedFiles',
      'publishedFiles',
    ])
  )
    return false
  if (
    !isBoundedCount(value.sourceBytesRead, BATCH_LIMITS.maxTotalFileBytes) ||
    !isBoundedCount(value.archiveBytesTransferred, BATCH_LIMITS.maxArchiveBytes) ||
    !isBoundedCount(value.fileBytesVerified, BATCH_LIMITS.maxTotalFileBytes) ||
    !isBoundedCount(value.fileBytesPublished, BATCH_LIMITS.maxTotalFileBytes) ||
    !isNullable(value.totalFileBytes, (item): item is number =>
      isBoundedCount(item, BATCH_LIMITS.maxTotalFileBytes),
    ) ||
    !isNullable(value.totalArchiveBytes, (item): item is number =>
      isBoundedCount(item, BATCH_LIMITS.maxArchiveBytes),
    ) ||
    !isBoundedCount(value.totalFiles, BATCH_LIMITS.maxFiles) ||
    value.totalFiles === 0 ||
    !isByteCount(value.verifiedFiles) ||
    !isByteCount(value.publishedFiles)
  )
    return false
  return (
    value.publishedFiles <= value.verifiedFiles &&
    value.verifiedFiles <= value.totalFiles &&
    value.fileBytesPublished <= value.fileBytesVerified &&
    (value.publishedFiles !== 0 || value.fileBytesPublished === 0) &&
    (value.totalFileBytes === null ||
      Math.max(value.sourceBytesRead, value.fileBytesVerified, value.fileBytesPublished) <=
        value.totalFileBytes) &&
    (value.totalFileBytes === null ||
      value.verifiedFiles !== value.totalFiles ||
      value.fileBytesVerified === value.totalFileBytes) &&
    (value.totalFileBytes === null ||
      value.publishedFiles !== value.totalFiles ||
      value.fileBytesPublished === value.totalFileBytes) &&
    (value.totalArchiveBytes === null ||
      (value.totalArchiveBytes > 0 && value.archiveBytesTransferred <= value.totalArchiveBytes))
  )
}

/** 比较同一任务的进度值：计数不可回退，未知总量可确定，已知总量不可改写。 */
export function isBatchProgressAdvance(previous: unknown, next: unknown): boolean {
  if (
    !isBatchProgress(previous) ||
    !isBatchProgress(next) ||
    previous.totalFiles !== next.totalFiles
  )
    return false
  const counters = [
    'sourceBytesRead',
    'archiveBytesTransferred',
    'fileBytesVerified',
    'fileBytesPublished',
    'verifiedFiles',
    'publishedFiles',
  ] as const
  return (
    counters.every((key) => previous[key] <= next[key]) &&
    (previous.totalFileBytes === null || previous.totalFileBytes === next.totalFileBytes) &&
    (previous.totalArchiveBytes === null || previous.totalArchiveBytes === next.totalArchiveBytes)
  )
}

/** 校验单文件结果的封闭联合；实际发布/内容/残留归属须由平台验证。 */
export function isFileOutcome(value: unknown): value is FileOutcome {
  if (!isRecord(value) || !isBatchFileId(value.fileId)) return false
  if (value.status === 'succeeded')
    return (
      hasShape(value, ['fileId', 'status', 'bytesWritten', 'sha256', 'entry']) &&
      isBoundedCount(value.bytesWritten, BATCH_LIMITS.maxFileBytes) &&
      isSha256(value.sha256) &&
      isEntryMetadata(value.entry) &&
      value.entry.kind === 'file' &&
      (value.entry.sizeBytes === null || value.entry.sizeBytes === value.bytesWritten)
    )
  if (value.status === 'not-attempted')
    return (
      hasShape(value, ['fileId', 'status', 'reason']) &&
      isOneOf(value.reason, ['batch-invalid', 'prior-failure', 'cancelled'])
    )
  const keys =
    value.status === 'cancelled'
      ? ['fileId', 'status', 'residualEntries']
      : ['fileId', 'status', 'error', 'residualEntries']
  if (
    !hasShape(value, keys) ||
    !isBoundedArray(value.residualEntries, isEntryReference, true) ||
    !hasUniqueReferences(value.residualEntries)
  )
    return false
  if (value.status === 'cancelled') return true
  return (
    isOperationError(value.error) &&
    ((value.status === 'failed' && value.error.code !== 'result-unknown') ||
      (value.status === 'unknown' && value.error.code === 'result-unknown'))
  )
}

function hasValidCleanup(value: Record<string, unknown>): boolean {
  switch (value.cleanupStatus) {
    case 'not-needed':
    case 'complete':
      return value.cleanupError === null
    case 'incomplete':
      return isOperationError(value.cleanupError) && value.cleanupError.code === 'cleanup-failed'
    case 'unknown':
      return isOperationError(value.cleanupError) && value.cleanupError.code === 'result-unknown'
    default:
      return false
  }
}

function hasValidResultOrder(results: readonly FileOutcome[]): boolean {
  if (!hasOrderedFileIds(results)) return false
  const publishedBytes = results.reduce(
    (sum, result) => sum + (result.status === 'succeeded' ? result.bytesWritten : 0),
    0,
  )
  if (publishedBytes > BATCH_LIMITS.maxTotalFileBytes) return false
  let hasStopped = false
  for (const result of results) {
    if (hasStopped && result.status !== 'not-attempted') return false
    if (result.status !== 'succeeded') hasStopped = true
  }
  return true
}

function hasValidReceiverTerminal(status: unknown, results: readonly FileOutcome[]): boolean {
  if (results.every((result) => result.status === 'succeeded')) return status === 'succeeded'
  if (results.some((result) => result.status === 'unknown'))
    return (
      status === 'unknown' &&
      results.every(
        (result) => result.status !== 'not-attempted' || result.reason === 'prior-failure',
      )
    )
  if (results.some((result) => result.status === 'failed'))
    return (
      status === 'failed' &&
      results.every(
        (result) => result.status !== 'not-attempted' || result.reason === 'prior-failure',
      )
    )
  if (
    results.some(
      (result) =>
        result.status === 'cancelled' ||
        (result.status === 'not-attempted' && result.reason === 'cancelled'),
    )
  )
    return (
      status === 'cancelled' &&
      results.every((result) => result.status !== 'not-attempted' || result.reason === 'cancelled')
    )
  return (
    status === 'failed' &&
    results.every(
      (result) => result.status === 'not-attempted' && result.reason === 'batch-invalid',
    )
  )
}

function hasValidRunningState(value: Record<string, unknown>): boolean {
  if (
    !hasShape(value, [
      'transferId',
      'direction',
      'role',
      'updatedAt',
      'status',
      'stage',
      'progress',
      'cancelRequested',
      'fileResults',
    ]) ||
    typeof value.cancelRequested !== 'boolean' ||
    !isBatchProgress(value.progress)
  )
    return false
  const progress = value.progress
  if (value.role === 'sender') {
    if (
      value.fileResults !== null ||
      !isOneOf(value.stage, ['preparing', 'ready', 'transferring', 'cleaning']) ||
      progress.fileBytesVerified !== 0 ||
      progress.fileBytesPublished !== 0 ||
      progress.verifiedFiles !== 0 ||
      progress.publishedFiles !== 0
    )
      return false
    if (value.stage === 'preparing') return progress.archiveBytesTransferred === 0
    if (value.stage === 'ready')
      return (
        progress.totalFileBytes !== null &&
        progress.sourceBytesRead === progress.totalFileBytes &&
        progress.totalArchiveBytes !== null &&
        progress.archiveBytesTransferred === 0
      )
    return (
      value.stage === 'cleaning' ||
      (progress.totalFileBytes !== null &&
        progress.totalArchiveBytes !== null &&
        progress.sourceBytesRead === progress.totalFileBytes)
    )
  }
  if (
    value.role !== 'receiver' ||
    !isOneOf(value.stage, [
      'preparing',
      'awaiting-content',
      'transferring',
      'verifying',
      'publishing',
      'cleaning',
    ]) ||
    progress.sourceBytesRead !== 0 ||
    !isBoundedArray(value.fileResults, isFileOutcome, true) ||
    !hasValidResultOrder(value.fileResults) ||
    value.fileResults.some((result) => result.status === 'not-attempted') ||
    value.fileResults.length > progress.totalFiles
  )
    return false
  const published = value.fileResults.filter((result) => result.status === 'succeeded')
  if (
    progress.publishedFiles !== published.length ||
    progress.fileBytesPublished !== published.reduce((sum, result) => sum + result.bytesWritten, 0)
  )
    return false
  if (value.stage === 'cleaning') return true
  if (progress.totalFileBytes === null || progress.totalArchiveBytes === null) return false
  if (value.stage === 'preparing' || value.stage === 'awaiting-content')
    return (
      progress.archiveBytesTransferred === 0 &&
      progress.fileBytesVerified === 0 &&
      progress.verifiedFiles === 0 &&
      value.fileResults.length === 0
    )
  if (value.stage === 'transferring')
    return (
      progress.fileBytesVerified === 0 &&
      progress.verifiedFiles === 0 &&
      value.fileResults.length === 0
    )
  if (progress.archiveBytesTransferred !== progress.totalArchiveBytes) return false
  if (value.stage === 'verifying') return value.fileResults.length === 0
  return (
    progress.verifiedFiles === progress.totalFiles &&
    progress.fileBytesVerified === progress.totalFileBytes
  )
}

/** 校验角色、阶段与终态聚合；清单/目标关系另用 matchesBatchState 校验。 */
export function isBatchState(value: unknown): value is BatchState {
  if (
    !isRecord(value) ||
    !isOpaqueId(value.transferId) ||
    !isOneOf(value.direction, ['windows-to-android', 'android-to-windows']) ||
    !isTimestamp(value.updatedAt)
  )
    return false
  if (value.status === 'running') return hasValidRunningState(value)
  if (
    !hasShape(value, [
      'transferId',
      'direction',
      'role',
      'updatedAt',
      'status',
      'error',
      'fileResults',
      'cleanupStatus',
      'cleanupError',
    ]) ||
    !hasValidCleanup(value)
  )
    return false
  if (value.status === 'failed') {
    if (!isOperationError(value.error) || value.error.code === 'result-unknown') return false
  } else if (value.status === 'unknown') {
    if (!isOperationError(value.error) || value.error.code !== 'result-unknown') return false
  } else if (!isOneOf(value.status, ['sent', 'succeeded', 'cancelled']) || value.error !== null)
    return false
  if (value.role === 'sender') return value.fileResults === null && value.status !== 'succeeded'
  return (
    value.role === 'receiver' &&
    value.status !== 'sent' &&
    isBoundedArray(value.fileResults, isFileOutcome) &&
    hasValidResultOrder(value.fileResults) &&
    hasValidReceiverTerminal(value.status, value.fileResults)
  )
}
