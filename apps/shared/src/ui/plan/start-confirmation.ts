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
 * @returns 来源目录为空或关闭了备份时返回确认内容，其余情况返回 null。
 */
// 计划页本身就是删除预览，开启备份时直接开始；来源为空会清空目标，关闭备份时删除和覆盖都无法恢复，这两种情况再确认。
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
  if (plan.shouldBackup) {
    return null
  }
  return {
    title: t('transfer.noBackupTitle'),
    text: count > 0 ? t('transfer.noBackupDeleteText', { count }) : t('transfer.noBackupText'),
  }
}
