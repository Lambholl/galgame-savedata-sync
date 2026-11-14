import { BATCH_LIMITS } from '../protocol/batch-limits.ts'
import { isOpaqueId, isPortableFileName } from '../protocol/protocol.ts'
import { isOperationError } from '../protocol/validation.ts'
import {
  hasShape,
  isArrayOf,
  isByteCount,
  isNullable,
  isRecord,
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

/** 校验扫描条目；文件夹的大小必须是 null。 */
export function isSyncEntry(value: unknown): value is SyncEntry {
  return (
    hasShape(value, ['entryId', 'path', 'kind', 'sizeBytes', 'modifiedAt', 'error']) &&
    isOpaqueId(value.entryId) &&
    isSyncPath(value.path) &&
    isNullable(value.modifiedAt, isTimestamp) &&
    isNullable(value.error, isOperationError) &&
    ((value.kind === 'directory' && value.sizeBytes === null) ||
      (value.kind === 'file' && isNullable(value.sizeBytes, isByteCount)))
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
    // 扫描失败时允许父链不完整，用来展示已读取的部分条目。
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

/** 校验计划输入的字段。 */
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

/** 校验扫描状态。 */
export function isSyncScanState(value: unknown): value is SyncScanState {
  if (
    !hasShape(value, [
      'schemaVersion',
      'scanId',
      'rootId',
      'status',
      'scannedEntries',
      'snapshot',
      'error',
    ]) ||
    value.schemaVersion !== SYNC_SCHEMA_VERSION ||
    !isOpaqueId(value.scanId) ||
    !isOpaqueId(value.rootId) ||
    !isByteCount(value.scannedEntries) ||
    value.scannedEntries > SYNC_LIMITS.maxEntries
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
    return (
      value.snapshot.entries.every(
        (entry) => entry.error === null && (entry.kind !== 'file' || entry.sizeBytes !== null),
      ) &&
      value.error === null &&
      value.snapshot.error === null &&
      value.snapshot.entries.length === value.scannedEntries
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

/** 校验能力声明；limits 必须与 SYNC_LIMITS 相同。 */
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

/** 校验扫描请求；版本未知或有额外字段时拒绝。 */
export function isSyncScanRequest(value: unknown): value is SyncScanRequest {
  return (
    hasShape(value, ['schemaVersion', 'rootId']) &&
    value.schemaVersion === SYNC_SCHEMA_VERSION &&
    isOpaqueId(value.rootId)
  )
}

const BACKUP_FILE_KEYS = ['fileId', 'path', 'sizeBytes', 'modifiedAt'] as const

function isBackupFile(value: unknown): value is SyncBackupFile {
  return (
    hasShape(value, BACKUP_FILE_KEYS) &&
    isOpaqueId(value.fileId) &&
    isSyncPath(value.path) &&
    value.path.every(isPortableFileName) &&
    isByteCount(value.sizeBytes) &&
    value.sizeBytes <= BATCH_LIMITS.maxFileBytes &&
    isNullable(value.modifiedAt, isTimestamp)
  )
}

/**
 * 读取保存在磁盘上的备份清单。文件项带 sha256 字段时照常读取，哈希值丢弃。
 *
 * @returns 格式不合法时返回 null。
 */
export function readSyncBackupManifest(value: unknown): SyncBackupManifest | null {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return null
  }
  const files = value.files.map((file: unknown) =>
    isRecord(file) && hasShape(file, [...BACKUP_FILE_KEYS, 'sha256'])
      ? Object.fromEntries(BACKUP_FILE_KEYS.map((key) => [key, file[key]]))
      : file,
  )
  const manifest: unknown = { ...value, files }
  return isSyncBackupManifest(manifest) ? manifest : null
}

/** 校验残留备份的描述。 */
export function isSyncIncompleteBackup(value: unknown): value is SyncIncompleteBackup {
  return (
    hasShape(value, ['backupId', 'occupiedBytes']) &&
    isOpaqueId(value.backupId) &&
    (value.occupiedBytes === null ||
      (Number.isSafeInteger(value.occupiedBytes) && (value.occupiedBytes as number) >= 0))
  )
}

/** 校验备份清单：fileId 连续，路径互不相同，文件数在上限以内。 */
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
