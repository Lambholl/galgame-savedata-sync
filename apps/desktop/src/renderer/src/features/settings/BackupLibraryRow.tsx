import { ExclamationCircleOutlined, FolderOutlined } from '@ant-design/icons'
import { PathText, useT } from '@savedata-sync/shared/ui'

/** BackupLibraryRow 的参数。 */
export interface BackupLibraryRowProps {
  /** 备份库文件夹的绝对路径。 */
  readonly path: string
  /** 是否是用户选择的位置；为 true 时多一个“恢复默认位置”按钮。 */
  readonly isCustom: boolean
  /** 备份库现在能否使用；为 false 时用警告样式并注明不可用。 */
  readonly isAvailable: boolean
  /** 为 true 时两个按钮都不能点，如正在更换位置时。 */
  readonly disabled: boolean
  /** 点“更换位置”时触发。 */
  readonly onChange: () => void
  /** 点“恢复默认位置”时触发。 */
  readonly onReset: () => void
}

/** 备份库位置一行：路径和状态，行尾是更换位置和恢复默认位置的按钮。 */
export function BackupLibraryRow({
  path,
  isCustom,
  isAvailable,
  disabled,
  onChange,
  onReset,
}: BackupLibraryRowProps): React.JSX.Element {
  const t = useT()
  return (
    <div className="ss-list backup-library-row">
      <div className="ss-list-row">
        <span className={`ss-list-lead ${isAvailable ? 'is-accent' : 'is-warn'}`}>
          {isAvailable ? <FolderOutlined /> : <ExclamationCircleOutlined />}
        </span>
        <span className="ss-list-body">
          <b>{t('backup.libraryLocation')}</b>
          <small>
            {isCustom ? null : `${t('backup.libraryDefault')} · `}
            <PathText path={path} />
          </small>
          {isAvailable ? null : (
            <span className="ss-list-warn">{t('backup.libraryUnavailable')}</span>
          )}
        </span>
        {isCustom ? (
          <button type="button" className="ss-list-link" disabled={disabled} onClick={onReset}>
            {t('backup.resetLibrary')}
          </button>
        ) : null}
        <button type="button" className="ss-list-link" disabled={disabled} onClick={onChange}>
          {t('backup.changeLibrary')}
        </button>
      </div>
    </div>
  )
}
