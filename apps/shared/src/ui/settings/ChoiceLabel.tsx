import type { ReactElement } from 'react'
import { CheckOutlined } from '@ant-design/icons'
import './choice-label.css'

/** 选择菜单中的文本与选中标记。 */
export interface ChoiceLabelProps {
  /** 选项的本地化名称。 */
  readonly text: string
  /** 当前选中时显示勾选，未选中时保留相同的图标空间。 */
  readonly isSelected: boolean
}

/** 选择菜单的一项：文字和选中标记。 */
export function ChoiceLabel({ text, isSelected }: ChoiceLabelProps): ReactElement {
  return (
    <span className="ss-choice-label">
      <span>{text}</span>
      <span className="ss-choice-check" aria-hidden="true">
        {isSelected && <CheckOutlined />}
      </span>
    </span>
  )
}
