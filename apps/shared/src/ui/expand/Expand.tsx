import type { ReactElement, ReactNode } from 'react'
import { DownOutlined } from '@ant-design/icons'
import './expand.css'

/** 可展开行下方的内容：高度随展开和收起平滑过渡；收起后内容隐藏，不能获得焦点，但保持挂载。 */
export function Expand({
  isOpen,
  children,
}: {
  readonly isOpen: boolean
  readonly children: ReactNode
}): ReactElement {
  return (
    <div className={`ss-expand${isOpen ? ' is-open' : ''}`}>
      <div className="ss-expand-inner">{children}</div>
    </div>
  )
}

/** 可展开行右侧的箭头：收起时朝下，展开时转向朝上。 */
export function ExpandChevron({ isOpen }: { readonly isOpen: boolean }): ReactElement {
  return <DownOutlined className={`ss-expand-chevron${isOpen ? ' is-open' : ''}`} />
}
