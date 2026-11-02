import { formatBytes } from '../../i18n/format.ts'
import type { SyncIncompleteBackup } from '../../sync/sync-contracts.ts'
import type { Translate } from '../../i18n/translate.ts'

/** 残留提示：份数和占用大小。有一份读不到就不报总数，避免把未知算成 0。 */
export function incompleteBackupText(items: readonly SyncIncompleteBackup[], t: Translate): string {
  let total: number | null = 0
  for (const item of items) {
    total = total === null || item.occupiedBytes === null ? null : total + item.occupiedBytes
  }
  return `${t('backup.incomplete', { count: items.length })} · ${
    total === null
      ? t('backup.occupiedUnknown')
      : t('backup.occupied', { size: formatBytes(total) })
  }`
}

/** 依次清理残留：一份失败不影响其他份，结束后抛出第一个错误。 */
export async function cleanupIncompleteBackups(
  items: readonly SyncIncompleteBackup[],
  cleanup: (backupId: string) => Promise<void>,
): Promise<void> {
  let failure: { readonly cause: unknown } | null = null
  for (const item of items) {
    try {
      await cleanup(item.backupId)
    } catch (cause) {
      failure ??= { cause }
    }
  }
  if (failure) {
    throw failure.cause
  }
}
