import { createPortal } from 'react-dom'
import type { ReactNode, ReactPortal } from 'react'
import { Button } from 'antd-mobile'

/** 页面底部整宽主按钮；放在页面动画容器之外，固定定位不随页面位移。 */
export function BottomAction({
  note,
  icon,
  label,
  isDisabled,
  isLoading,
  onClick,
}: {
  readonly note: string | null
  readonly icon: ReactNode
  readonly label: string
  readonly isDisabled: boolean
  readonly isLoading: boolean
  readonly onClick: () => void
}): ReactPortal {
  return createPortal(
    <div className="bottom-action">
      {note && <p>{note}</p>}
      <Button
        block
        color="primary"
        size="large"
        disabled={isDisabled}
        loading={isLoading}
        onClick={onClick}
      >
        {icon}
        <span>{label}</span>
      </Button>
    </div>,
    document.body,
  )
}
