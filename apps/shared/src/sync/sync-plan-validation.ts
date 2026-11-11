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
 * 校验计划：重新推导全部动作、问题和计数，与计划中的值逐项比较。
 * 对象键的顺序可以不同，数组顺序必须与 createSyncPlan 的输出相同。
 */
export function isSyncPlan(value: unknown): value is SyncPlan {
  if (
    !hasShape(value, [
      'planId',
      'projectId',
      'operation',
      'direction',
      'shouldBackup',
      'shouldDeleteExtras',
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
    shouldDeleteExtras: value.shouldDeleteExtras,
    source: value.source,
    target: value.target,
  }
  return isSyncPlanInput(input) && sameValue(value, createSyncPlan(input))
}

/** 判断计划是否由给定输入生成。 */
export function matchesSyncPlan(value: unknown, input: SyncPlanInput): value is SyncPlan {
  return isSyncPlanInput(input) && isSyncPlan(value) && sameValue(value, createSyncPlan(input))
}
