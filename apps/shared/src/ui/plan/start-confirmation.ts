import type { Translate } from '../../i18n/translate.ts'
import type { SyncPlan } from '../../sync/sync-contracts.ts'

/** 开始传输前需要再确认一次的内容。 */
export interface SyncStartConfirmation {
  readonly title: string
  readonly text: string
}

/**
 * 判断开始传输前是否需要再确认一次。
 *
 * @returns 来源目录为空、目标有条目要删除时返回确认内容，其余情况返回 null。
 */
// 计划页本身就是删除和覆盖的预览，直接开始；只有来源为空会清空整个目标，再确认一次。
export function syncStartConfirmation(plan: SyncPlan, t: Translate): SyncStartConfirmation | null {
  const count = plan.entries.filter(
    (entry) => entry.action === 'delete-file' || entry.action === 'delete-directory',
  ).length
  if (count > 0 && plan.source.entries.length === 0) {
    return {
      title: t('transfer.wipeTitle'),
      text: t(plan.shouldBackup ? 'transfer.wipeBackupText' : 'transfer.wipeNoBackupText', {
        count,
      }),
    }
  }
  return null
}
