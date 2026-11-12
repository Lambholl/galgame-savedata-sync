import type { SyncWriteOutcome } from '../../sync/sync-contracts.ts'

/** 未成功写入的结果条目。 */
export type UnsettledOutcome = SyncWriteOutcome & {
  readonly status: Exclude<SyncWriteOutcome['status'], 'succeeded'>
}

/** 取出写入结果里没有成功的条目。 */
export function unsettledOutcomes(
  outcomes: readonly SyncWriteOutcome[],
): readonly UnsettledOutcome[] {
  return outcomes.filter((item): item is UnsettledOutcome => item.status !== 'succeeded')
}

/** 判断结果条目是不是删除。 */
export function isDeleteOutcome(item: SyncWriteOutcome): boolean {
  return item.action === 'delete-file' || item.action === 'delete-directory'
}

/** 写入结果按类别的条目数。 */
export interface OutcomeCounts {
  /** 成功写入的文件数，不含文件夹和删除。 */
  readonly files: number
  /** 成功新建的文件夹数。 */
  readonly folders: number
  /** 成功删除的条目数。 */
  readonly deleted: number
  /** 成功的条目总数。 */
  readonly succeeded: number
  readonly failed: number
  /** 结果待确认的条目数。 */
  readonly unknown: number
  /** 取消时还没执行或没执行到的条目数，不算失败。 */
  readonly skipped: number
}

/** 统计写入结果。 */
export function countOutcomes(outcomes: readonly SyncWriteOutcome[]): OutcomeCounts {
  const succeeded = outcomes.filter((item) => item.status === 'succeeded')
  const folders = succeeded.filter((item) => item.action === 'create-directory').length
  const deleted = succeeded.filter(isDeleteOutcome).length
  const count = (status: SyncWriteOutcome['status']): number =>
    outcomes.filter((item) => item.status === status).length
  return {
    files: succeeded.length - folders - deleted,
    folders,
    deleted,
    succeeded: succeeded.length,
    failed: count('failed'),
    unknown: count('unknown'),
    skipped: count('cancelled') + count('not-attempted'),
  }
}
