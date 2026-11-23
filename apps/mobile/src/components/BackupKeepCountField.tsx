import { List, Stepper } from 'antd-mobile'
import { BACKUP_KEEP_COUNT_MAX, BACKUP_KEEP_COUNT_MIN } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'

/** BackupKeepCountField 的参数。 */
export interface BackupKeepCountFieldProps {
  /** 当前的保留份数。 */
  readonly keepCount: number
  /** 改成 BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX 内的另一个整数时触发。 */
  readonly onChange: (keepCount: number) => void
}

/** 备份库保留份数一行（需置于 List 内），作用于每个游戏的全部备份。 */
export function BackupKeepCountField({
  keepCount,
  onChange,
}: BackupKeepCountFieldProps): React.JSX.Element {
  const t = useT()
  return (
    <List.Item
      extra={
        <Stepper
          min={BACKUP_KEEP_COUNT_MIN}
          max={BACKUP_KEEP_COUNT_MAX}
          digits={0}
          value={keepCount}
          onChange={onChange}
        />
      }
    >
      {t('backup.keepCount')}
    </List.Item>
  )
}
