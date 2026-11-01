import type { ReactElement } from 'react'
import { RightOutlined, SafetyOutlined, StopOutlined } from '@ant-design/icons'
import { PathText } from '../path-text/PathText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './backup.css'

/** BackupPolicyBlock 的参数。 */
export interface BackupPolicyBlockProps {
  /** 写入前备份是否开启；关闭时整块变红。 */
  readonly isEnabled: boolean
  /** 开启时保留的份数。 */
  readonly keepCount: number
  /** 这个游戏单独设置；false 表示跟随全局设置。 */
  readonly isCustom: boolean
  /** 备份保存位置；不在这里显示时为 null（手机放在页脚）。 */
  readonly location: string | null
  /** 点开修改策略；不能修改时为 null。 */
  readonly onEdit: (() => void) | null
}

/** 备份页顶部的策略状态块：是否开启、保留几份、保存在哪里，点开修改。 */
export function BackupPolicyBlock({
  isEnabled,
  keepCount,
  isCustom,
  location,
  onEdit,
}: BackupPolicyBlockProps): ReactElement {
  const t = useT()
  const caption = `${isCustom ? t('backup.customSetting') : t('backup.followGlobal')} · ${
    isEnabled ? t('backup.keep', { count: keepCount }) : t('backup.offHint')
  }`
  return (
    <button
      type="button"
      className={`ss-policy${isEnabled ? '' : ' is-off'}`}
      disabled={!onEdit}
      onClick={onEdit ?? undefined}
    >
      <span className="ss-policy-icon">{isEnabled ? <SafetyOutlined /> : <StopOutlined />}</span>
      <span className="ss-policy-body">
        <b>{isEnabled ? t('backup.on') : t('backup.off')}</b>
        <small>
          {location ? (
            <>
              {caption} · {t('backup.location')} <PathText path={location} />
            </>
          ) : (
            caption
          )}
        </small>
      </span>
      {onEdit && <RightOutlined className="ss-policy-chevron" />}
    </button>
  )
}
