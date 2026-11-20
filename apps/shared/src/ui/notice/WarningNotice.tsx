import type { ReactElement } from 'react'
import { Alert, Button } from 'antd'
import './warning-notice.css'

/** {@link WarningNotice} 的参数。 */
export interface WarningNoticeProps {
  /** 左侧的提示文字。 */
  readonly text: string
  /** 右侧按钮的文字。 */
  readonly actionLabel: string
  /** 右侧按钮是否禁用。 */
  readonly isActionDisabled: boolean
  /** 点击右侧按钮时调用；按钮禁用时不调用。 */
  readonly onAction: () => void
}

/** 琥珀色警告条：左侧是带图标的提示文字，右侧是一个处理按钮。 */
export function WarningNotice({
  text,
  actionLabel,
  isActionDisabled,
  onAction,
}: WarningNoticeProps): ReactElement {
  return (
    <Alert
      className="ss-warning-notice"
      showIcon
      type="warning"
      title={text}
      action={
        <Button type="text" size="small" disabled={isActionDisabled} onClick={onAction}>
          {actionLabel}
        </Button>
      }
    />
  )
}
