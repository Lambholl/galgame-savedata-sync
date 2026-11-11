import type { ReactElement } from 'react'
import { ExclamationCircleOutlined, FolderOutlined } from '@ant-design/icons'
import { PathText } from '../path-text/PathText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './devices.css'

/** FolderRow 的参数。 */
export interface FolderRowProps {
  /** 目录名；未选择目录时为 null。 */
  readonly name: string | null
  /** 目录的完整路径；平台给不出时为 null。 */
  readonly path: string | null
  /** 目录已失效、无法读写。 */
  readonly isLost: boolean
  /** 打开系统目录选择器；不能更换时为 null。 */
  readonly onChange: (() => void) | null
}

/** 本机存档目录一行：目录名和路径，行尾是更换按钮；目录失效时用警告样式并说明原因。 */
export function FolderRow({ name, path, isLost, onChange }: FolderRowProps): ReactElement {
  const t = useT()
  const body = (
    <>
      <span className={`ss-list-lead ${isLost ? 'is-warn' : 'is-accent'}`}>
        {isLost ? <ExclamationCircleOutlined /> : <FolderOutlined />}
      </span>
      <span className="ss-list-body">
        <b>{name ?? t('game.noFolder')}</b>
        {path && (
          <small>
            <PathText path={path} />
          </small>
        )}
        {isLost && <span className="ss-list-warn">{t('game.folderLost')}</span>}
      </span>
    </>
  )
  const action = isLost
    ? t('game.reselectFolder')
    : name
      ? t('game.changeFolder')
      : t('game.chooseFolder')
  return (
    <div className="ss-list">
      {onChange ? (
        <button type="button" className="ss-list-row ss-pressable" onClick={onChange}>
          {body}
          <span className={`ss-list-link${isLost ? ' is-warn' : ''}`}>{action}</span>
        </button>
      ) : (
        <div className="ss-list-row">{body}</div>
      )}
    </div>
  )
}
