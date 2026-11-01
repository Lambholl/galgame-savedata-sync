import { createPortal } from 'react-dom'
import type { ReactNode, ReactPortal } from 'react'
import { Button } from 'antd-mobile'

/**
 * 页面唯一的主操作：右下角悬浮的胶囊按钮，没有底栏和说明文字。
 * 放在页面动画容器之外，固定定位不随页面位移；页面按 app-main-with-action 在末尾留出它的高度。
 */
export function FloatingAction({
  color,
  icon,
  iconPlacement,
  label,
  isDisabled,
  isLoading,
  onClick,
}: {
  /** primary 为常规主操作；danger 用于取消传输这类中止操作。 */
  readonly color: 'primary' | 'danger'
  readonly icon: ReactNode
  /** 图标在文字前（start）还是文字后（end）。 */
  readonly iconPlacement: 'start' | 'end'
  readonly label: string
  readonly isDisabled: boolean
  readonly isLoading: boolean
  readonly onClick: () => void
}): ReactPortal {
  return createPortal(
    <Button
      className="floating-action"
      color={color}
      size="large"
      disabled={isDisabled}
      loading={isLoading}
      onClick={onClick}
    >
      {iconPlacement === 'start' && icon}
      <span>{label}</span>
      {iconPlacement === 'end' && icon}
    </Button>,
    document.body,
  )
}
