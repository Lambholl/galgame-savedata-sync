import { List, Stepper } from 'antd-mobile'
import { BACKUP_KEEP_COUNT_MAX, BACKUP_KEEP_COUNT_MIN } from '@savedata-sync/shared'
import type { SyncBackupPolicy } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { SwitchItem } from './SwitchItem'

/** 写入前备份的开关与保留份数，放在 List 里；关闭时不显示份数。 */
export function BackupPolicyFields({
  policy,
  isDisabled,
  onChange,
}: {
  readonly policy: SyncBackupPolicy
  readonly isDisabled: boolean
  readonly onChange: (next: SyncBackupPolicy) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <SwitchItem
        title={t('backup.switch')}
        isChecked={policy.shouldBackup}
        isDisabled={isDisabled}
        onChange={(shouldBackup) => onChange({ ...policy, shouldBackup })}
      />
      {policy.shouldBackup && (
        <List.Item
          disabled={isDisabled}
          extra={
            <Stepper
              min={BACKUP_KEEP_COUNT_MIN}
              max={BACKUP_KEEP_COUNT_MAX}
              digits={0}
              value={policy.keepCount}
              disabled={isDisabled}
              onChange={(keepCount) => onChange({ ...policy, keepCount })}
            />
          }
        >
          {t('backup.keepCount')}
        </List.Item>
      )}
    </>
  )
}
