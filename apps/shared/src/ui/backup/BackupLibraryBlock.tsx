import type { ReactElement } from 'react'
import { HistoryOutlined, RightOutlined } from '@ant-design/icons'
import { PathText } from '../path-text/PathText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './backup.css'

/** BackupLibraryBlock 的参数。 */
export interface BackupLibraryBlockProps {
  /** 备份库为每个游戏保留的备份份数。 */
  readonly keepCount: number
  /** 备份库的位置；为 null 时不显示。 */
  readonly location: string | null
  /** 点按时触发，打开修改备份库设置的地方；不能修改时为 null。 */
  readonly onEdit: (() => void) | null
}

/** 备份库状态块：每个游戏保留几份、保存在哪里。 */
export function BackupLibraryBlock({
  keepCount,
  location,
  onEdit,
}: BackupLibraryBlockProps): ReactElement {
  const t = useT()
  return (
    <button
      type="button"
      className="ss-policy ss-pressable"
      disabled={!onEdit}
      onClick={onEdit ?? undefined}
    >
      <span className="ss-policy-icon">
        <HistoryOutlined />
      </span>
      <span className="ss-policy-body">
        <b>{t('backup.keep', { count: keepCount })}</b>
        {location ? (
          <small>
            {t('backup.location')} <PathText path={location} />
          </small>
        ) : null}
      </span>
      {onEdit ? <RightOutlined className="ss-policy-chevron" /> : null}
    </button>
  )
}
