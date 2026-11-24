import type { ReactElement, ReactNode } from 'react'
import { Alert, Button } from 'antd'
import './notice.css'

/** {@link Notice} 右侧的处理按钮。 */
export interface NoticeAction {
  /** 按钮文字。 */
  readonly label: string
  /** 按钮是否禁用。 */
  readonly isDisabled: boolean
  /** 点击按钮时调用；按钮禁用时不调用。 */
  readonly onClick: () => void
}

/** {@link Notice} 的参数。 */
export interface NoticeProps {
  /** warning：琥珀色警告；error：红色错误。 */
  readonly tone: 'warning' | 'error'
  /** 左侧图标后的提示内容。 */
  readonly text: ReactNode
  /** 右侧的处理按钮；为 null 时不显示按钮。 */
  readonly action: NoticeAction | null
}

/** 提示条：左侧是带图标的提示内容，右侧可带一个与提示条同色的实底处理按钮。 */
export function Notice({ tone, text, action }: NoticeProps): ReactElement {
  return (
    <Alert
      className={`ss-notice is-${tone}`}
      showIcon
      type={tone}
      title={text}
      action={
        action ? (
          <Button
            type="text"
            size="small"
            disabled={action.isDisabled}
            onClick={() => action.onClick()}
          >
            {action.label}
          </Button>
        ) : null
      }
    />
  )
}
