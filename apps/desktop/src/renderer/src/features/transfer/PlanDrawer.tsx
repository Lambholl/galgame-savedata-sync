import type { ReactNode } from 'react'
import { Button, Drawer } from 'antd'

/** 抽屉底部右侧唯一的主操作。 */
export interface PlanDrawerAction {
  readonly label: string
  readonly icon: ReactNode
  readonly isDanger: boolean
  readonly isLoading: boolean
  readonly isDisabled: boolean
  readonly onClick: () => void
}

/**
 * 计划确认抽屉：传输计划和恢复预览共用。标题右侧写游戏名，正文是计划或进度，
 * 底部只放一个靠右的主操作，没有时不显示底部。
 */
export function PlanDrawer({
  isOpen,
  title,
  gameName,
  action,
  children,
  onClose,
}: {
  readonly isOpen: boolean
  readonly title: string
  readonly gameName: string
  readonly action: PlanDrawerAction | null
  readonly children: ReactNode
  readonly onClose: () => void
}): React.JSX.Element {
  return (
    <Drawer
      open={isOpen}
      size={560}
      title={title}
      extra={<span className="transfer-drawer-game">{gameName}</span>}
      destroyOnHidden
      classNames={{ footer: 'transfer-drawer-footer' }}
      footer={
        action && (
          <Button
            type="primary"
            danger={action.isDanger}
            size="large"
            icon={action.icon}
            loading={action.isLoading}
            disabled={action.isDisabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        )
      }
      onClose={onClose}
    >
      {children}
    </Drawer>
  )
}
