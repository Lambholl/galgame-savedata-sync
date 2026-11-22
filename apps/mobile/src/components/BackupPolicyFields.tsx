import { List, Stepper } from 'antd-mobile'
import { BACKUP_KEEP_COUNT_MAX, BACKUP_KEEP_COUNT_MIN } from '@savedata-sync/shared'
import type { SyncBackupPolicy } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { SwitchItem } from './SwitchItem'

/** 写入前自动备份开关与保留份数（需置于 List 内）；保留份数始终显示，作用于自动与手动备份。 */
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
    </>
  )
}
