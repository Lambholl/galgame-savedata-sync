import { Form, InputNumber, Switch } from 'antd'
import { BACKUP_KEEP_COUNT_MAX, BACKUP_KEEP_COUNT_MIN } from '@savedata-sync/shared'
import type { SyncBackupPolicy } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { NUMBER_FIELD } from '../settings/setting-form.ts'

/** 写入前自动备份开关与保留份数（需置于 Form 内）；保留份数始终显示，作用于自动与手动备份。 */
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
      <Form.Item label={t('backup.switch')}>
        <Switch
          aria-label={t('backup.switch')}
          checked={policy.shouldBackup}
          disabled={isDisabled}
          onChange={(shouldBackup) => onChange({ ...policy, shouldBackup })}
        />
      </Form.Item>
      <Form.Item label={t('backup.keepCount')} wrapperCol={NUMBER_FIELD}>
        <InputNumber<number>
          mode="spinner"
          aria-label={t('backup.keepCount')}
          min={BACKUP_KEEP_COUNT_MIN}
          max={BACKUP_KEEP_COUNT_MAX}
          precision={0}
          value={policy.keepCount}
          disabled={isDisabled}
          onChange={(keepCount) => {
            if (keepCount !== null) {
              onChange({ ...policy, keepCount })
            }
          }}
        />
      </Form.Item>
    </>
  )
}
