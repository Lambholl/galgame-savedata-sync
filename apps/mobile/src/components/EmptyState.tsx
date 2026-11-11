import type { ReactNode } from 'react'
import { FolderOutlined } from '@ant-design/icons'

/** 空状态：图标、说明和下方的操作。 */
export function EmptyState({
  description,
  children,
}: {
  readonly description: string
  /** 说明下方的操作。 */
  readonly children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <FolderOutlined aria-hidden="true" />
      <p>{description}</p>
      {children}
    </div>
  )
}
