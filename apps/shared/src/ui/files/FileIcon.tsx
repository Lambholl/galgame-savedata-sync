import type { ReactElement } from 'react'
import { FileImageOutlined, FileOutlined, FolderOutlined } from '@ant-design/icons'
import type { FileKind } from '../../sync/snapshot-compare.ts'
import './file-icon.css'

/**
 * 图标右上角的状态点：warn 表示内容不同或文件夹内有不一致，new 表示只在来源有、将在目标新建，
 * only 表示只在目标有、会保留，delete 表示只在目标有、这次会删除。
 */
export type FileIconMarker = 'none' | 'warn' | 'new' | 'only' | 'delete'

/** FileIcon 的参数。 */
export interface FileIconProps {
  /** 条目类型，决定图标和底色：文件夹为主色，图片为青色，其他文件为中性色。 */
  readonly kind: FileKind
  /** 状态点，颜色与行底色相同。 */
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
