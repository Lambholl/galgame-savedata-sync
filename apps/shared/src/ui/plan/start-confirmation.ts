import type { Translate } from '../../i18n/translate.ts'
import type { SyncPlan } from '../../sync/sync-contracts.ts'

/** 开始传输前要用户再确认一次的内容；弹窗由各端自己显示。 */
export interface SyncStartConfirmation {
  readonly title: string
  readonly text: string
}

/**
 * 开始传输前是否要再确认一次；不需要时返回 null。
 * 计划页就是删除预览，所以开启备份时直接开始；只有来源目录为空（目标会被清空）
 * 或关闭了备份（删除和覆盖都无法恢复）时才确认。
 */
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
