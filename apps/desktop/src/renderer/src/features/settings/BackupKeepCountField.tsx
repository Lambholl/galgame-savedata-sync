import { Form, InputNumber } from 'antd'
import { BACKUP_KEEP_COUNT_MAX, BACKUP_KEEP_COUNT_MIN } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { NUMBER_FIELD } from './setting-form.ts'

/** BackupKeepCountField 的参数。 */
export interface BackupKeepCountFieldProps {
  /** 当前的保留份数。 */
  readonly keepCount: number
  /** 输入了 BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX 内的整数时触发；清空输入框不触发。 */
  readonly onChange: (keepCount: number) => void
}

/** 备份库保留份数一行（需置于 Form 内），作用于每个游戏的全部备份。 */
export function BackupKeepCountField({
  keepCount,
  onChange,
}: BackupKeepCountFieldProps): React.JSX.Element {
  const t = useT()
  return (
    <Form.Item label={t('backup.keepCount')} wrapperCol={NUMBER_FIELD}>
      <InputNumber<number>
        mode="spinner"
        aria-label={t('backup.keepCount')}
        min={BACKUP_KEEP_COUNT_MIN}
        max={BACKUP_KEEP_COUNT_MAX}
        precision={0}
        value={keepCount}
        onChange={(value) => {
          if (value !== null) {
            onChange(value)
          }
        }}
      />
    </Form.Item>
  )
}
