import type { ReactNode } from 'react'
import { Popup, Button } from 'antd-mobile'
import { CloseOutlined } from '@ant-design/icons'

/** 受控底部弹层，返回键由应用按层级协调。 */
export function Sheet({
  isOpen,
  title,
  isBusy = false,
  layer = 1000,
  onClose,
  children,
}: {
  readonly isOpen: boolean
  readonly title: string
  readonly isBusy?: boolean
  readonly layer?: number
  readonly onClose: () => void
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <Popup
      visible={isOpen}
      position="bottom"
      onClose={onClose}
      closeOnMaskClick={!isBusy}
      style={{ '--z-index': String(layer) }}
      bodyClassName="mobile-sheet"
      destroyOnClose
    >
      <section role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" />
        <header className="sheet-heading">
          <h2>{title}</h2>
          <Button fill="none" aria-label="关闭" disabled={isBusy} onClick={onClose}>
            <CloseOutlined />
          </Button>
        </header>
        <div className="sheet-content">{children}</div>
      </section>
    </Popup>
  )
}
