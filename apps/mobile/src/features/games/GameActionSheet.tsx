import type { ReactNode } from 'react'
import { useT } from '@savedata-sync/shared/ui'
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
  const t = useT()
  return (
    <Sheet isOpen={isOpen} title={gameName ?? t('game.actions')} onClose={onClose}>
      {children}
    </Sheet>
  )
}
