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
