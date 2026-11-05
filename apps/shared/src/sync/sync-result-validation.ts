import type { OperationError } from '../protocol/contracts.ts'
import { isOpaqueId, isSha256 } from '../protocol/protocol.ts'
import { isOperationError } from '../protocol/validation.ts'
import { hasShape, isArrayOf, isByteCount, isNullable } from '../validation/data-validation.ts'
import { SYNC_LIMITS, SYNC_SCHEMA_VERSION } from './sync-contracts.ts'
import type { SyncApplyResult, SyncPlan, SyncWriteOutcome } from './sync-contracts.ts'
import { isSyncPath, syncPathKey } from './sync-paths.ts'
import { isSyncPlan } from './sync-plan-validation.ts'
import { isSyncFileWrite, isSyncWriteEntry, selectSyncBackupFiles } from './sync-plan.ts'

function isCleanupError(value: unknown): value is OperationError {
  return isOperationError(value) && value.code === 'cleanup-failed'
}

/** 校验一项写入结果：写文件成功要带实际文件指纹；目录、删除和所有未确认的结果没有字节和哈希。 */
export function isSyncWriteOutcome(value: unknown): value is SyncWriteOutcome {
  if (
    !hasShape(value, ['path', 'action', 'status', 'sizeBytes', 'sha256', 'error']) ||
    !isSyncPath(value.path) ||
    typeof value.action !== 'string' ||
    ![
      'create-directory',
      'create-file',
      'replace-file',
      'delete-file',
      'delete-directory',
    ].includes(value.action) ||
    !isNullable(value.error, isOperationError)
  ) {
    return false
  }
  if (value.status === 'succeeded') {
    return (
      value.error === null &&
      (value.action === 'create-file' || value.action === 'replace-file'
        ? isByteCount(value.sizeBytes) && isSha256(value.sha256)
        : value.sizeBytes === null && value.sha256 === null)
    )
  }
  if (value.sizeBytes !== null || value.sha256 !== null) {
    return false
  }
  if (value.status === 'unknown') {
    return value.error?.code === 'result-unknown'
  }
  if (value.status === 'failed') {
    return value.error !== null && value.error.code !== 'result-unknown'
  }
  return (value.status === 'cancelled' || value.status === 'not-attempted') && value.error === null
}

/** 校验写入结果的结构；清理成功或 HTTP 200 不算写入成功。 */
export function isSyncApplyResult(value: unknown): value is SyncApplyResult {
  return (
    hasShape(value, [
      'schemaVersion',
      'planId',
      'backupId',
      'backupFileCount',
      'outcomes',
      'error',
      'cleanupError',
    ]) &&
    value.schemaVersion === SYNC_SCHEMA_VERSION &&
    isOpaqueId(value.planId) &&
    isNullable(value.backupId, isOpaqueId) &&
    (value.backupFileCount === null ||
      (value.backupId !== null &&
        Number.isSafeInteger(value.backupFileCount) &&
        (value.backupFileCount as number) >= 0 &&
        (value.backupFileCount as number) <= SYNC_LIMITS.maxEntries)) &&
    Array.isArray(value.outcomes) &&
    value.outcomes.length <= SYNC_LIMITS.maxEntries &&
    isArrayOf(value.outcomes, isSyncWriteOutcome) &&
    new Set(value.outcomes.map((item) => syncPathKey(item.path))).size === value.outcomes.length &&
    isNullable(value.error, isOperationError) &&
    isNullable(value.cleanupError, isCleanupError)
  )
}

/**
 * 核对写入结果与本次可执行计划：完整集合、顺序和成功指纹都要一致，漏项和错误目标都拒绝。
 * 第一个失败或取消之后只允许未执行项；实际 IO 和备份是否有效由原生层负责。
 */
export function matchesSyncApplyResult(value: unknown, plan: SyncPlan): value is SyncApplyResult {
  if (
    !isSyncPlan(plan) ||
    !plan.canExecute ||
    !isSyncApplyResult(value) ||
    value.planId !== plan.planId
  ) {
    return false
  }
  const expected = plan.entries.filter(isSyncWriteEntry)
  if (expected.length !== value.outcomes.length) {
    return false
  }
  const source = new Map(plan.source.entries.map((entry) => [entry.entryId, entry]))
  const shouldCreateBackup = selectSyncBackupFiles(plan).length > 0
  let hasStopped = false
  let hasUnsuccessful = false
  let hasCancellation = false
  for (const [index, outcome] of value.outcomes.entries()) {
    const entry = expected[index]
    if (
      !entry ||
      entry.action !== outcome.action ||
      syncPathKey(entry.path) !== syncPathKey(outcome.path) ||
      (hasStopped && outcome.status !== 'not-attempted')
    ) {
      return false
    }
    if (outcome.status === 'succeeded') {
      if (isSyncFileWrite(entry.action)) {
        const file = source.get(entry.sourceEntryId ?? '')
        if (!file || outcome.sizeBytes !== file.sizeBytes || outcome.sha256 !== file.sha256) {
          return false
        }
      }
      if (shouldCreateBackup && value.backupId === null) {
        return false
      }
    } else {
      hasUnsuccessful = true
      hasStopped = true
      hasCancellation = outcome.status === 'cancelled' || hasCancellation
    }
    if (outcome.status === 'unknown' && value.error?.code !== 'result-unknown') {
      return false
    }
    if (outcome.status === 'failed' && value.error === null) {
      return false
    }
  }
  return (
    expected.length === 0 ||
    (hasUnsuccessful ? value.error !== null || hasCancellation : value.error === null)
  )
}
