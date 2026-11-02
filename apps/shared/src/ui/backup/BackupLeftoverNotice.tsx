import type { ReactElement } from 'react'
import { Alert, Button } from 'antd'
import type { SyncIncompleteBackup } from '../../sync/sync-contracts.ts'
import { useT } from '../i18n/i18n-context.ts'
import { incompleteBackupText } from './backup-leftover.ts'
import './backup.css'

/** 未完成备份的提示条：一行写份数和占用大小，行尾是清理。 */
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
    <Alert
      className="ss-leftover"
      showIcon
      type="warning"
      title={incompleteBackupText(items, t)}
      action={
        <Button type="text" size="small" disabled={isDisabled} onClick={onCleanup}>
          {t('backup.cleanup')}
        </Button>
      }
    />
  )
}
