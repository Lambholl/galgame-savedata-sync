import { hasShape, isRecord } from '../validation/data-validation.ts'
import type { SyncPlan, SyncPlanInput } from './sync-contracts.ts'
import { createSyncPlan } from './sync-plan.ts'
import { isSyncPlanInput } from './sync-validation.ts'

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      right.every((item: unknown, index) => sameValue(left[index], item))
    )
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false
  }
  const keys = Object.keys(right)
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => Object.hasOwn(left, key) && sameValue(left[key], right[key]))
  )
}

/**
 * 重新推导全部动作/问题/计数，拒绝伪造 canExecute、过滤冲突或错位源目标。
 * JSON 对象键顺序不影响匹配，数组顺序须为计划器的确定顺序；不执行平台 IO。
 */
export function isSyncPlan(value: unknown): value is SyncPlan {
  if (
    !hasShape(value, [
      'planId',
      'projectId',
      'operation',
      'direction',
      'shouldBackup',
      'source',
      'target',
      'schemaVersion',
      'entries',
      'issues',
      'transferFileCount',
      'totalFileBytes',
      'backupFileBytes',
      'canExecute',
    ])
  ) {
    return false
  }
  const input = {
    planId: value.planId,
    projectId: value.projectId,
    operation: value.operation,
    direction: value.direction,
    shouldBackup: value.shouldBackup,
    source: value.source,
    target: value.target,
  }
  return isSyncPlanInput(input) && sameValue(value, createSyncPlan(input))
}

/** 对照调用方持有的本次输入核对整份计划；平台仍需重核会话和实际文件状态。 */
export function matchesSyncPlan(value: unknown, input: SyncPlanInput): value is SyncPlan {
  return isSyncPlanInput(input) && isSyncPlan(value) && sameValue(value, createSyncPlan(input))
}
