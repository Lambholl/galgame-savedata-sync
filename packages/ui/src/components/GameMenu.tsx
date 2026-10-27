import type { ReactNode } from 'react'
import { Modal } from 'antd'
import { Popup } from 'antd-mobile'

export function GameMenu({
  isMobile,
  isOpen,
  gameName,
  onClose,
  children,
}: {
  readonly isMobile: boolean
  readonly isOpen: boolean
  readonly gameName: string | null
  readonly onClose: () => void
  readonly children: ReactNode
}): React.JSX.Element {
  if (isMobile) {
    return (
      <Popup
        visible={isOpen}
        onMaskClick={onClose}
        onClose={onClose}
        bodyClassName="library-game-popup"
      >
        <h2>{gameName}</h2>
        {children}
      </Popup>
    )
  }
  return (
    <Modal title={gameName} open={isOpen} footer={null} onCancel={onClose}>
      {children}
    </Modal>
  )
}
