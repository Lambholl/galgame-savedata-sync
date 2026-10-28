import { BATCH_LIMITS } from '../protocol/batch-limits.ts'
import { isBatchManifest } from '../protocol/batch-validation.ts'
import { isOpaqueId } from '../protocol/protocol.ts'
import { isOperationError } from '../protocol/validation.ts'
import {
  hasShape,
  isByteCount,
  isNullable,
  isOneOf,
  isTimestamp,
} from '../validation/data-validation.ts'
import { isSyncProjectBinding } from '../library/project-binding.ts'
import { isSyncPlan } from './sync-plan-validation.ts'
import { isSyncApplyResult, matchesSyncApplyResult } from './sync-result-validation.ts'
import { isSyncSnapshot } from './sync-validation.ts'
import { createSyncPlan } from './sync-plan.ts'
import { syncPathKey } from './sync-paths.ts'
import type { SyncPlan } from './sync-contracts.ts'
import type { BatchManifest } from '../protocol/batch-contracts.ts'
import type {
  SyncJobProgress,
  SyncJobRequest,
  SyncJobState,
  SyncPreparationPreview,
  SyncPreparationState,
  SyncProjectDescriptor,
  SyncTransferState,
} from './sync-job-contracts.ts'

function direction(value: unknown): value is 'android-to-windows' | 'windows-to-android' {
  return value === 'android-to-windows' || value === 'windows-to-android'
}
function isBoundedCount(value: unknown, maximum: number): value is number {
  return isByteCount(value) && value <= maximum
}
function hasJsonBudget(value: unknown): boolean {
  let bytes = 0
  for (const character of JSON.stringify(value)) {
    const code = character.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes > BATCH_LIMITS.maxJsonBytes) {
      return false
    }
  }
  return true
}
export function isSyncProjectDescriptor(value: unknown): value is SyncProjectDescriptor {
  return (
    hasShape(value, ['schemaVersion', 'projectId', 'deviceId', 'rootId', 'shouldBackup']) &&
    value.schemaVersion === 1 &&
    [value.projectId, value.deviceId, value.rootId].every(isOpaqueId) &&
    typeof value.shouldBackup === 'boolean'
  )
}
/** 从完整计划重算守卫，不接收被过滤的动作或本机恢复请求。 */
export function isSyncJobRequest(value: unknown): value is SyncJobRequest {
  return (
    hasShape(value, ['schemaVersion', 'jobId', 'sourceProjectId', 'targetProjectId', 'plan']) &&
    value.schemaVersion === 1 &&
    [value.jobId, value.sourceProjectId, value.targetProjectId].every(isOpaqueId) &&
    isSyncPlan(value.plan) &&
    value.plan.canExecute &&
    value.plan.operation === 'copy' &&
    value.plan.planId === value.jobId &&
    value.plan.projectId === value.targetProjectId &&
    hasJsonBudget(value)
  )
}
/** 源引用/父目录/名称/原日期和实际指纹逐项匹配，归档成员始终为连续 fileId。 */
export function matchesSyncJobManifest(
  value: unknown,
  request: SyncJobRequest,
): value is BatchManifest | null {
  if (!isSyncJobRequest(request)) {
    return false
  }
  if (request.plan.transferFileCount === 0) {
    return value === null
  }
  if (
    !isBatchManifest(value) ||
    value.transferId !== request.jobId ||
    value.sourceDeviceId !== request.plan.source.deviceId ||
    value.sourceRootId !== request.plan.source.rootId ||
    value.totalFileBytes !== request.plan.totalFileBytes ||
    value.files.length !== request.plan.transferFileCount
  ) {
    return false
  }
  const operations = request.plan.entries.filter(
    (entry) => entry.action === 'create-file' || entry.action === 'replace-file',
  )
  const source = new Map(request.plan.source.entries.map((entry) => [entry.entryId, entry]))
  const paths = new Map(
    request.plan.source.entries.map((entry) => [syncPathKey(entry.path), entry]),
  )
  return value.files.every((file, index) => {
    const operation = operations[index],
      entry = source.get(operation?.sourceEntryId ?? '')
    if (!entry) {
      return false
    }
    const parentId =
      entry.path.length === 1 ? null : paths.get(syncPathKey(entry.path.slice(0, -1)))?.entryId
    return (
      file.sourceEntryId === entry.entryId &&
      file.sourceParentId === parentId &&
      file.sourceName === entry.path.at(-1) &&
      file.sourceModifiedAt === entry.modifiedAt &&
      file.sizeBytes === entry.sizeBytes &&
      file.sha256 === entry.sha256
    )
  })
}
export function isSyncJobProgress(value: unknown): value is SyncJobProgress {
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
    ]) ||
    !isBoundedCount(value.totalFileBytes, BATCH_LIMITS.maxTotalFileBytes) ||
    !isBoundedCount(value.totalFiles, BATCH_LIMITS.maxFiles) ||
    !isBoundedCount(value.sourceBytesRead, value.totalFileBytes) ||
    !isBoundedCount(value.fileBytesVerified, value.totalFileBytes) ||
    !isBoundedCount(value.fileBytesPublished, value.fileBytesVerified) ||
    !isBoundedCount(value.verifiedFiles, value.totalFiles) ||
    !isBoundedCount(value.publishedFiles, value.verifiedFiles) ||
    !isNullable(value.totalArchiveBytes, (item): item is number =>
      isBoundedCount(item, BATCH_LIMITS.maxArchiveBytes),
    ) ||
    !isBoundedCount(
      value.archiveBytesTransferred,
      value.totalArchiveBytes ?? BATCH_LIMITS.maxArchiveBytes,
    )
  ) {
    return false
  }
  return (
    (value.totalFiles > 0 || (value.totalFileBytes === 0 && value.totalArchiveBytes === 0)) &&
    (value.totalArchiveBytes !== 0 || value.totalFiles === 0) &&
    (value.totalArchiveBytes !== null || value.archiveBytesTransferred === 0) &&
    (value.verifiedFiles !== value.totalFiles ||
      value.fileBytesVerified === value.totalFileBytes) &&
    (value.publishedFiles !== value.totalFiles ||
      value.fileBytesPublished === value.totalFileBytes) &&
    (value.publishedFiles !== 0 || value.fileBytesPublished === 0)
  )
}
/** 校验本端状态，不把 HTTP 成功、sender sent 或清理状态冒充 receiver 成功。 */
export function isSyncJobState(value: unknown): value is SyncJobState {
  if (
    !hasShape(value, [
      'schemaVersion',
      'jobId',
      'direction',
      'role',
      'status',
      'stage',
      'updatedAt',
      'cancelRequested',
      'progress',
      'result',
      'error',
      'cleanupError',
    ]) ||
    value.schemaVersion !== 1 ||
    !isOpaqueId(value.jobId) ||
    !direction(value.direction) ||
    !isOneOf(value.role, ['sender', 'receiver']) ||
    !isTimestamp(value.updatedAt) ||
    typeof value.cancelRequested !== 'boolean' ||
    !isSyncJobProgress(value.progress) ||
    !isNullable(value.result, isSyncApplyResult) ||
    !isNullable(value.error, isOperationError) ||
    !isNullable(
      value.cleanupError,
      (item): item is NonNullable<SyncJobState['cleanupError']> =>
        isOperationError(item) && item.code === 'cleanup-failed',
    )
  ) {
    return false
  }
  if (
    !isOneOf(value.stage, [
      'preparing',
      'awaiting-content',
      'transferring',
      'verifying',
      'backing-up',
      'writing',
      'cleaning',
      'done',
    ])
  ) {
    return false
  }
  if (
    value.role === 'sender' &&
    (value.result !== null ||
      value.progress.fileBytesPublished !== 0 ||
      value.progress.publishedFiles !== 0)
  ) {
    return false
  }
  if (value.role === 'receiver' && value.progress.sourceBytesRead !== 0) {
    return false
  }
  if (
    value.result !== null &&
    (value.result.planId !== value.jobId ||
      value.result.error?.code !== value.error?.code ||
      value.result.error?.message !== value.error?.message ||
      value.result.error?.canRetry !== value.error?.canRetry)
  ) {
    return false
  }
  if (value.status === 'running') {
    return value.stage !== 'done' && value.error === null && value.result === null
  }
  if (value.stage !== 'done') {
    return false
  }
  if (value.role === 'receiver' && value.result === null) {
    return false
  }
  if (value.status === 'sent') {
    return (
      value.role === 'sender' &&
      value.error === null &&
      value.progress.sourceBytesRead === value.progress.totalFileBytes &&
      value.progress.totalArchiveBytes !== null &&
      value.progress.archiveBytesTransferred === value.progress.totalArchiveBytes
    )
  }
  if (value.status === 'succeeded') {
    return (
      value.role === 'receiver' &&
      value.error === null &&
      value.result !== null &&
      value.result.outcomes.every((item) => item.status === 'succeeded') &&
      value.progress.verifiedFiles === value.progress.totalFiles &&
      value.progress.publishedFiles === value.progress.totalFiles
    )
  }
  if (value.status === 'cancelled') {
    return value.error === null && value.cancelRequested
  }
  if (value.status === 'unknown') {
    return value.error?.code === 'result-unknown'
  }
  return value.status === 'failed' && value.error !== null && value.error.code !== 'result-unknown'
}
/** 绑定本次计划/清单、角色和完整逐项结果；清单未准备时归档总量保持 null。 */
export function matchesSyncJobState(
  value: unknown,
  request: SyncJobRequest,
  manifest: BatchManifest | null,
): value is SyncJobState {
  if (
    !isSyncJobRequest(request) ||
    !isSyncJobState(value) ||
    value.jobId !== request.jobId ||
    value.direction !== request.plan.direction ||
    value.progress.totalFileBytes !== request.plan.totalFileBytes ||
    value.progress.totalFiles !== request.plan.transferFileCount
  ) {
    return false
  }
  if (manifest !== null && !matchesSyncJobManifest(manifest, request)) {
    return false
  }
  if (manifest !== null && value.progress.totalArchiveBytes !== manifest.archive.sizeBytes) {
    return false
  }
  if (request.plan.transferFileCount === 0 && value.progress.totalArchiveBytes !== 0) {
    return false
  }
  if (
    request.plan.transferFileCount > 0 &&
    manifest === null &&
    value.progress.totalArchiveBytes !== null
  ) {
    return false
  }
  if (value.result === null) {
    return true
  }
  const published = value.result.outcomes.filter(
    (item) => item.status === 'succeeded' && item.action !== 'create-directory',
  )
  return (
    matchesSyncApplyResult(value.result, request.plan) &&
    value.progress.publishedFiles === published.length &&
    value.progress.fileBytesPublished ===
      published.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
  )
}
export function isSyncPreparationState(value: unknown): value is SyncPreparationState {
  return (
    hasShape(value, ['schemaVersion', 'preparationId', 'direction', 'status', 'error']) &&
    value.schemaVersion === 1 &&
    isOpaqueId(value.preparationId) &&
    direction(value.direction) &&
    (value.status === 'failed'
      ? isOperationError(value.error)
      : isOneOf(value.status, ['preparing', 'ready', 'cancelled']) && value.error === null)
  )
}
export function isSyncPreparationPreview(value: unknown): value is SyncPreparationPreview {
  if (
    !hasShape(value, [
      'schemaVersion',
      'preparationId',
      'direction',
      'binding',
      'source',
      'target',
      'shouldBackup',
    ]) ||
    value.schemaVersion !== 1 ||
    !isOpaqueId(value.preparationId) ||
    !direction(value.direction) ||
    !isSyncProjectBinding(value.binding) ||
    !isSyncSnapshot(value.source) ||
    !isSyncSnapshot(value.target) ||
    typeof value.shouldBackup !== 'boolean'
  ) {
    return false
  }
  const upload = value.direction === 'android-to-windows'
  return (
    value.source.deviceId ===
      (upload ? value.binding.localDeviceId : value.binding.remoteDeviceId) &&
    value.source.rootId === (upload ? value.binding.localRootId : value.binding.remoteRootId) &&
    value.target.deviceId ===
      (upload ? value.binding.remoteDeviceId : value.binding.localDeviceId) &&
    value.target.rootId === (upload ? value.binding.remoteRootId : value.binding.localRootId)
  )
}
/** 纯比较，不执行 IO；项目 ID 使用目标端本机项目，避免两端不同 ID 混入备份分组。 */
export function syncPlanFromPreview(preview: SyncPreparationPreview): SyncPlan {
  if (!isSyncPreparationPreview(preview)) {
    throw new Error('本次同步预览上下文无效。')
  }
  return createSyncPlan({
    planId: preview.preparationId,
    projectId:
      preview.direction === 'android-to-windows'
        ? preview.binding.remoteProjectId
        : preview.binding.projectId,
    operation: 'copy',
    direction: preview.direction,
    shouldBackup: preview.shouldBackup,
    source: preview.source,
    target: preview.target,
  })
}
export function isSyncTransferState(value: unknown): value is SyncTransferState {
  return (
    hasShape(value, ['schemaVersion', 'jobId', 'local', 'remote', 'remoteError']) &&
    value.schemaVersion === 1 &&
    isOpaqueId(value.jobId) &&
    isSyncJobState(value.local) &&
    value.local.jobId === value.jobId &&
    isNullable(value.remote, isSyncJobState) &&
    (value.remote === null ||
      (value.remote.jobId === value.jobId &&
        value.remote.direction === value.local.direction &&
        value.remote.role !== value.local.role)) &&
    isNullable(value.remoteError, isOperationError)
  )
}
