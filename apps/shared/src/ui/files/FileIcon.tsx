import type { ReactElement } from 'react'
import { FileImageOutlined, FileOutlined, FolderOutlined } from '@ant-design/icons'
import type { FileKind } from '../../sync/snapshot-compare.ts'
import './file-icon.css'

/** 图标右上角的状态点：warn 为内容不同（或文件夹内有不一致），only 为只在一端有。 */
export type FileIconMarker = 'none' | 'warn' | 'only'

/** FileIcon 的参数。 */
export interface FileIconProps {
  /** 条目类型，决定图标和底色：文件夹为主色，图片为青色，其他文件为中性色。 */
  readonly kind: FileKind
  /** 状态点；与行底色同色，色弱时仍能凭有无状态点分辨。 */
  readonly marker: FileIconMarker
}

/** 文件、文件夹或图片的方形图标。 */
export function FileIcon({ kind, marker }: FileIconProps): ReactElement {
  return (
    <span className={`ss-file-icon is-${kind}`} aria-hidden="true">
      {kind === 'directory' ? (
        <FolderOutlined />
      ) : kind === 'image' ? (
        <FileImageOutlined />
      ) : (
        <FileOutlined />
      )}
      {marker !== 'none' && <i className={`ss-file-icon-marker is-${marker}`} />}
    </span>
  )
}
