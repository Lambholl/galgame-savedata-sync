import type { ReactNode } from 'react'
import { Sheet } from '../../components/Sheet'

export function GameMenu({
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
    <Sheet isOpen={isOpen} title={gameName ?? '游戏操作'} onClose={onClose}>
      {children}
    </Sheet>
  )
}
