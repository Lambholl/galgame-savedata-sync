import type { ReactNode } from 'react'
import { Modal } from 'antd'

export function GameActionDialog({
  isOpen,
  gameName,
  onClose,
  children,
}: {
  readonly isOpen: boolean
  readonly gameName: string | null
  readonly onClose: () => void
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <Modal title={gameName} open={isOpen} footer={null} onCancel={onClose}>
      {children}
    </Modal>
  )
}
