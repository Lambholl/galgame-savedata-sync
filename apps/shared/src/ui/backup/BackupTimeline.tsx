import type { ReactElement } from 'react'
import { formatBytes } from '../../i18n/format.ts'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import '../devices/devices.css'
import './backup.css'

/** 一份完整的备份。 */
export interface BackupItem {
  /** 备份 ID，传回选择或恢复回调。 */
  readonly id: string
  /** 创建时间（毫秒）。 */
  readonly createdAt: number
  /** 由什么触发：传输前或恢复前。 */
  readonly reason: 'copy' | 'restore'
  /** 文件数。 */
  readonly fileCount: number
  /** 文件总字节数。 */
  readonly totalBytes: number
}

/**
 * 行的交互方式。select：整行可选（电脑，右侧显示所选备份）；
 * restore：每行一个“恢复”按钮（手机，点后打开恢复弹层）。
 */
export type BackupTimelineAction =
  | {
      readonly kind: 'select'
      /** 当前选中的备份；未选时为 null。 */
      readonly selectedId: string | null
      readonly onSelect: (id: string) => void
    }
  | {
      readonly kind: 'restore'
      /** 正在传输或恢复时禁用。 */
      readonly isDisabled: boolean
      readonly onRestore: (id: string) => void
    }

/** BackupTimeline 的参数。 */
export interface BackupTimelineProps {
  /** 按时间倒序的备份。 */
  readonly backups: readonly BackupItem[]
  /** 行的交互方式。 */
  readonly action: BackupTimelineAction
}

/** 备份时间线：每行写明日期时间、由什么触发、文件数与大小。 */
export function BackupTimeline({ backups, action }: BackupTimelineProps): ReactElement {
  const t = useT()
  const locale = useLocale()
  if (!backups.length) {
    return <p className="ss-list-empty">{t('backup.none')}</p>
  }
  const day = new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' })
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return (
    <div className="ss-list">
      {backups.map((item) => {
        const content = (
          <>
            <span className="ss-tl-when">
              <b>{day.format(item.createdAt)}</b>
              {time.format(item.createdAt)}
            </span>
            <span className="ss-list-body">
              <b>{t(`backup.reason.${item.reason}`)}</b>
              <small>
                {t('backup.files', { count: item.fileCount, size: formatBytes(item.totalBytes) })}
              </small>
            </span>
          </>
        )
        if (action.kind === 'select') {
          const isSelected = action.selectedId === item.id
          return (
            <button
              type="button"
              key={item.id}
              className={`ss-list-row${isSelected ? ' is-selected' : ''}`}
              aria-pressed={isSelected}
              onClick={() => action.onSelect(item.id)}
            >
              {content}
            </button>
          )
        }
        return (
          <div className="ss-list-row" key={item.id}>
            {content}
            <button
              type="button"
              className="ss-tl-restore"
              disabled={action.isDisabled}
              onClick={() => action.onRestore(item.id)}
            >
              {t('backup.restore')}
            </button>
          </div>
        )
      })}
    </div>
  )
}
