import type { ReactElement } from 'react'
import { FolderOutlined } from '@ant-design/icons'
import { PathText } from '../path-text/PathText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './devices.css'

/** FolderRow 的参数。 */
export interface FolderRowProps {
  /** 目录名；未选择目录时为 null。 */
  readonly name: string | null
  /** 目录的完整路径；平台给不出时为 null。 */
  readonly path: string | null
  /** 打开系统目录选择器；不能更换时为 null。 */
  readonly onChange: (() => void) | null
}

/** 本机存档目录一行：目录名与路径，末尾“更换”打开系统选择器。 */
export function FolderRow({ name, path, onChange }: FolderRowProps): ReactElement {
  const t = useT()
  const body = (
    <>
      <span className="ss-list-lead is-accent">
        <FolderOutlined />
      </span>
      <span className="ss-list-body">
        <b>{name ?? t('game.noFolder')}</b>
        {path && (
          <small>
            <PathText path={path} />
          </small>
        )}
      </span>
    </>
  )
  return (
    <div className="ss-list">
      {onChange ? (
        <button type="button" className="ss-list-row ss-pressable" onClick={onChange}>
          {body}
          <span className="ss-list-link">
            {name ? t('game.changeFolder') : t('game.chooseFolder')}
          </span>
        </button>
      ) : (
        <div className="ss-list-row">{body}</div>
      )}
    </div>
  )
}
