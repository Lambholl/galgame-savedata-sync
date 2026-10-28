import type { OperationError } from '../protocol/contracts.ts'
import { isOpaqueId, isSha256 } from '../protocol/protocol.ts'
import { isOperationError } from '../protocol/validation.ts'
import { hasShape, isArrayOf, isByteCount, isNullable } from '../validation/data-validation.ts'
import { SYNC_LIMITS, SYNC_SCHEMA_VERSION } from './sync-contracts.ts'
import type { SyncApplyResult, SyncPlan, SyncWriteOutcome } from './sync-contracts.ts'
import { isSyncPath, syncPathKey } from './sync-paths.ts'
import { isSyncPlan } from './sync-plan-validation.ts'

function isCleanupError(value: unknown): value is OperationError {
  return isOperationError(value) && value.code === 'cleanup-failed'
}

/** 结果成功需携带实际文件指纹；目录成功和所有未确认结果都不伪造字节/哈希。 */
export function isSyncWriteOutcome(value: unknown): value is SyncWriteOutcome {
  if (
    !hasShape(value, ['path', 'action', 'status', 'sizeBytes', 'sha256', 'error']) ||
    !isSyncPath(value.path) ||
    typeof value.action !== 'string' ||
    !['create-directory', 'create-file', 'replace-file'].includes(value.action) ||
    !isNullable(value.error, isOperationError)
  ) {
    return false
  }
  if (value.status === 'succeeded') {
    return (
      value.error === null &&
      (value.action === 'create-directory'
        ? value.sizeBytes === null && value.sha256 === null
        : isByteCount(value.sizeBytes) && isSha256(value.sha256))
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

/** 校验独立结果 DTO，不把清理成功或 HTTP 200 当成写入成功。 */
export function isSyncApplyResult(value: unknown): value is SyncApplyResult {
  return (
    hasShape(value, ['schemaVersion', 'planId', 'backupId', 'outcomes', 'error', 'cleanupError']) &&
    value.schemaVersion === SYNC_SCHEMA_VERSION &&
    isOpaqueId(value.planId) &&
    isNullable(value.backupId, isOpaqueId) &&
    Array.isArray(value.outcomes) &&
    value.outcomes.length <= SYNC_LIMITS.maxEntries &&
    isArrayOf(value.outcomes, isSyncWriteOutcome) &&
    new Set(value.outcomes.map((item) => syncPathKey(item.path))).size === value.outcomes.length &&
    isNullable(value.error, isOperationError) &&
    isNullable(value.cleanupError, isCleanupError)
  )
}

/**
 * 核对本次可执行计划的完整写入集合、顺序和成功指纹；拒绝漏项及错误目标。
 * 最初失败/取消后只允许未执行项；实际 IO、备份有效性仍由原生层证明。
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
  const expected = plan.entries.filter((entry) =>
    ['create-directory', 'create-file', 'replace-file'].includes(entry.action),
  )
  if (expected.length !== value.outcomes.length) {
    return false
  }
  const source = new Map(plan.source.entries.map((entry) => [entry.entryId, entry]))
  const shouldCreateBackup =
    plan.shouldBackup && expected.some((entry) => entry.action === 'replace-file')
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
      if (entry.action !== 'create-directory') {
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
