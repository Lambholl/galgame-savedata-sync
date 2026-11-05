import { BATCH_LIMITS } from '../protocol/batch-limits.ts'
import { isOpaqueId, isPortableFileName, isSha256 } from '../protocol/protocol.ts'
import { isOperationError } from '../protocol/validation.ts'
import {
  hasShape,
  isArrayOf,
  isByteCount,
  isNullable,
  isTimestamp,
} from '../validation/data-validation.ts'
import { SYNC_CAPABILITIES_VERSION, SYNC_LIMITS, SYNC_SCHEMA_VERSION } from './sync-contracts.ts'
import type {
  SyncBackupFile,
  SyncBackupManifest,
  SyncIncompleteBackup,
  SyncCapabilities,
  SyncEntry,
  SyncPlanInput,
  SyncScanState,
  SyncScanRequest,
  SyncSnapshot,
} from './sync-contracts.ts'
import { isSyncPath, syncNameKey, syncPathKey } from './sync-paths.ts'

/** 校验已解析的条目；文件指纹可以未知，但计划器会阻止执行。 */
export function isSyncEntry(value: unknown): value is SyncEntry {
  return (
    hasShape(value, ['entryId', 'path', 'kind', 'sizeBytes', 'modifiedAt', 'sha256', 'error']) &&
    isOpaqueId(value.entryId) &&
    isSyncPath(value.path) &&
    isNullable(value.modifiedAt, isTimestamp) &&
    isNullable(value.error, isOperationError) &&
    ((value.kind === 'directory' && value.sizeBytes === null && value.sha256 === null) ||
      (value.kind === 'file' &&
        isNullable(value.sizeBytes, isByteCount) &&
        isNullable(value.sha256, isSha256)))
  )
}

function hasValidTree(entries: readonly SyncEntry[], hasScanError: boolean): boolean {
  const paths = new Map<string, SyncEntry>()
  const ids = new Set<string>()
  for (const entry of entries) {
    const key = syncPathKey(entry.path)
    if (paths.has(key) || ids.has(entry.entryId)) {
      return false
    }
    paths.set(key, entry)
    ids.add(entry.entryId)
  }
  return entries.every((entry) => {
    if (entry.path.length === 1) {
      return true
    }
    const parent = paths.get(syncPathKey(entry.path.slice(0, -1)))
    // 扫描失败允许不完整父链，以展示已读取的部分条目；仍不能执行。
    return parent ? parent.kind === 'directory' : hasScanError
  })
}

/** 校验快照：字段、路径和 ID 唯一性以及目录父链。 */
export function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  return (
    hasShape(value, [
      'schemaVersion',
      'scanId',
      'deviceId',
      'rootId',
      'observedAt',
      'entries',
      'error',
    ]) &&
    value.schemaVersion === SYNC_SCHEMA_VERSION &&
    isOpaqueId(value.scanId) &&
    isOpaqueId(value.deviceId) &&
    isOpaqueId(value.rootId) &&
    isTimestamp(value.observedAt) &&
    isNullable(value.error, isOperationError) &&
    Array.isArray(value.entries) &&
    value.entries.length <= SYNC_LIMITS.maxEntries &&
    isArrayOf(value.entries, isSyncEntry) &&
    hasValidTree(value.entries, value.error !== null)
  )
}

/** 校验计划输入：方向必须显式给出；结构合法不表示快照可执行或会话仍有效。 */
export function isSyncPlanInput(value: unknown): value is SyncPlanInput {
  return (
    hasShape(value, [
      'planId',
      'projectId',
      'operation',
      'direction',
      'shouldBackup',
      'shouldDeleteExtras',
      'source',
      'target',
    ]) &&
    isOpaqueId(value.planId) &&
    isOpaqueId(value.projectId) &&
    ((value.operation === 'copy' &&
      (value.direction === 'windows-to-android' || value.direction === 'android-to-windows')) ||
      (value.operation === 'restore' &&
        value.direction === 'local-restore' &&
        value.shouldBackup === true &&
        value.shouldDeleteExtras === false)) &&
    typeof value.shouldBackup === 'boolean' &&
    typeof value.shouldDeleteExtras === 'boolean' &&
    isSyncSnapshot(value.source) &&
    isSyncSnapshot(value.target)
  )
}

/** 校验扫描状态及其与句柄的绑定；已读字节是文件进度，不是目录汇总大小。 */
export function isSyncScanState(value: unknown): value is SyncScanState {
  if (
    !hasShape(value, [
      'schemaVersion',
      'scanId',
      'rootId',
      'status',
      'scannedEntries',
      'bytesRead',
      'snapshot',
      'error',
    ]) ||
    value.schemaVersion !== SYNC_SCHEMA_VERSION ||
    !isOpaqueId(value.scanId) ||
    !isOpaqueId(value.rootId) ||
    !isByteCount(value.scannedEntries) ||
    value.scannedEntries > SYNC_LIMITS.maxEntries ||
    !isByteCount(value.bytesRead)
  ) {
    return false
  }
  if (value.status === 'running' || value.status === 'cancelled') {
    return value.snapshot === null && value.error === null
  }
  if (
    !isSyncSnapshot(value.snapshot) ||
    value.snapshot.scanId !== value.scanId ||
    value.snapshot.rootId !== value.rootId ||
    value.snapshot.entries.length > value.scannedEntries
  ) {
    return false
  }
  if (value.status === 'succeeded') {
    let bytes = 0
    for (const entry of value.snapshot.entries) {
      if (
        entry.error !== null ||
        (entry.kind === 'file' && (entry.sizeBytes === null || entry.sha256 === null))
      ) {
        return false
      }
      if (entry.kind === 'file') {
        bytes += entry.sizeBytes ?? 0
      }
    }
    return (
      value.error === null &&
      value.snapshot.error === null &&
      value.snapshot.entries.length === value.scannedEntries &&
      Number.isSafeInteger(bytes) &&
      bytes === value.bytesRead
    )
  }
  return (
    value.status === 'failed' &&
    isOperationError(value.error) &&
    value.snapshot.error?.code === value.error.code &&
    value.snapshot.error.message === value.error.message &&
    value.snapshot.error.canRetry === value.error.canRetry
  )
}

/** 校验能力声明：逐项写明已实现的功能；固定的扫描上限不能被远端放宽。 */
export function isSyncCapabilities(value: unknown): value is SyncCapabilities {
  if (
    !hasShape(value, [
      'schemaVersion',
      'deviceId',
      'canScan',
      'canCopy',
      'canBackup',
      'canRestore',
      'limits',
    ])
  ) {
    return false
  }
  const limits = value.limits
  return (
    value.schemaVersion === SYNC_CAPABILITIES_VERSION &&
    isOpaqueId(value.deviceId) &&
    [value.canScan, value.canCopy, value.canBackup, value.canRestore].every(
      (item) => item === 'supported' || item === 'unsupported' || item === 'unknown',
    ) &&
    hasShape(limits, Object.keys(SYNC_LIMITS)) &&
    Object.entries(SYNC_LIMITS).every(([key, maximum]) => limits[key] === maximum)
  )
}

/** 校验扫描请求；上限固定在原生层，未知版本、路径和额外字段都拒绝。 */
export function isSyncScanRequest(value: unknown): value is SyncScanRequest {
  return (
    hasShape(value, ['schemaVersion', 'rootId']) &&
    value.schemaVersion === SYNC_SCHEMA_VERSION &&
    isOpaqueId(value.rootId)
  )
}

function isBackupFile(value: unknown): value is SyncBackupFile {
  return (
    hasShape(value, ['fileId', 'path', 'sizeBytes', 'sha256', 'modifiedAt']) &&
    isOpaqueId(value.fileId) &&
    isSyncPath(value.path) &&
    value.path.every(isPortableFileName) &&
    isByteCount(value.sizeBytes) &&
    value.sizeBytes <= BATCH_LIMITS.maxFileBytes &&
    isSha256(value.sha256) &&
    isNullable(value.modifiedAt, isTimestamp)
  )
}

export function isSyncIncompleteBackup(value: unknown): value is SyncIncompleteBackup {
  return (
    hasShape(value, ['backupId', 'occupiedBytes']) &&
    isOpaqueId(value.backupId) &&
    (value.occupiedBytes === null ||
      (Number.isSafeInteger(value.occupiedBytes) && (value.occupiedBytes as number) >= 0))
  )
}

/** 校验备份清单（独立的持久格式）：私有 fileId 连续，路径不重复，不超过上限。 */
export function isSyncBackupManifest(value: unknown): value is SyncBackupManifest {
  if (
    !hasShape(value, [
      'schemaVersion',
      'backupId',
      'projectId',
      'deviceId',
      'rootId',
      'createdAt',
      'reason',
      'files',
    ]) ||
    value.schemaVersion !== SYNC_SCHEMA_VERSION ||
    !isOpaqueId(value.backupId) ||
    !isOpaqueId(value.projectId) ||
    !isOpaqueId(value.deviceId) ||
    !isOpaqueId(value.rootId) ||
    !isTimestamp(value.createdAt) ||
    (value.reason !== 'copy' && value.reason !== 'restore') ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > BATCH_LIMITS.maxFiles ||
    !isArrayOf(value.files, isBackupFile)
  ) {
    return false
  }
  let bytes = 0
  const paths = new Set<string>()
  for (const [index, file] of value.files.entries()) {
    const key = syncNameKey(file.path)
    bytes += file.sizeBytes
    if (
      file.fileId !== `f${String(index + 1).padStart(6, '0')}` ||
      paths.has(key) ||
      bytes > BATCH_LIMITS.maxTotalFileBytes
    ) {
      return false
    }
    paths.add(key)
  }
  // 备份只含文件，不能同时把某个文件路径当成另一个文件的父目录。
  return value.files.every((file) =>
    file.path.every(
      (segment, index) =>
        segment.length > 0 && (index === 0 || !paths.has(syncNameKey(file.path.slice(0, index)))),
    ),
  )
}
