import type { ReactElement } from 'react'
import type { SyncIncompleteBackup } from '../../sync/sync-contracts.ts'
import { useT } from '../i18n/i18n-context.ts'
import { Notice } from '../notice/Notice.tsx'
import { incompleteBackupText } from './backup-leftover.ts'

/** 未完成备份的提示条：一行写份数和占用大小，行尾是清理按钮。 */
export function BackupLeftoverNotice({
  items,
  isDisabled,
  onCleanup,
}: {
  readonly items: readonly SyncIncompleteBackup[]
  readonly isDisabled: boolean
  readonly onCleanup: () => void
}): ReactElement {
  const t = useT()
  return (
    <Notice
      tone="warning"
      text={incompleteBackupText(items, t)}
      action={{ label: t('backup.cleanup'), isDisabled, onClick: onCleanup }}
    />
  )
}
