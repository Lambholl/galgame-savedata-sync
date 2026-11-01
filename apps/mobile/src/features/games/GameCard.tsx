import { useEffect, useRef } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import type { LibraryGame } from '@savedata-sync/shared'
import { GameCard as SharedGameCard } from '@savedata-sync/shared/ui'

/** 点击和长按打开同一个游戏菜单；滚动或取消触控时撤销长按计时。 */
export function GameCard({
  game,
  coverIndex,
  onOpenGame,
}: {
  readonly game: LibraryGame
  readonly coverIndex: number
  readonly onOpenGame: (game: LibraryGame) => void
}): React.JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const didLongPress = useRef(false)

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
    },
    [],
  )

  function cancelLongPress(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }

  function startLongPress(event: PointerEvent<HTMLDivElement>): void {
    cancelLongPress()
    didLongPress.current = false
    if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) {
      return
    }
    origin.current = { x: event.clientX, y: event.clientY }
    timer.current = setTimeout(() => {
      timer.current = null
      didLongPress.current = true
      onOpenGame(game)
    }, 500)
  }

  function movePointer(event: PointerEvent<HTMLDivElement>): void {
    const start = origin.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelLongPress()
    }
  }

  function openContextMenu(event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault()
    cancelLongPress()
    if (!didLongPress.current) {
      didLongPress.current = true
      onOpenGame(game)
    }
  }

  function clickGame(event: MouseEvent<HTMLDivElement>): void {
    if (didLongPress.current && event.detail !== 0) {
      event.preventDefault()
      event.stopPropagation()
      didLongPress.current = false
    }
  }

  return (
    <div
      className="game-card"
      onClickCapture={clickGame}
      onPointerDown={startLongPress}
      onPointerMove={movePointer}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={openContextMenu}
    >
      <SharedGameCard
        gameName={game.name}
        linkCount={game.links.length}
        coverIndex={coverIndex}
        onOpen={() => onOpenGame(game)}
      />
    </div>
  )
}
