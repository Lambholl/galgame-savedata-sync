import { createPortal } from 'react-dom'
import type { ReactNode, ReactPortal } from 'react'
import { Button } from 'antd-mobile'

/** 浮动操作放在页面动画容器之外，避免位移动画改变 fixed 定位及滚动时遮挡边界。 */
export function FloatingPageAction({
  icon,
  label,
  ariaLabel,
  isDisabled,
  isLoading = false,
  onClick,
}: {
  readonly icon: ReactNode
  readonly label?: string
  readonly ariaLabel: string
  readonly isDisabled: boolean
  readonly isLoading?: boolean
  readonly onClick: () => void
}): ReactPortal {
  return createPortal(
    <Button
      className={`library-fab${label ? ' library-fab-label' : ''}`}
      color="primary"
      aria-label={ariaLabel}
      disabled={isDisabled}
      loading={isLoading}
      onClick={onClick}
    >
      {icon}
      {label && <span>{label}</span>}
    </Button>,
    document.body,
  )
}
