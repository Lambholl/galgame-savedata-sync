import { useEffect, useRef } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import { FolderOutlined, RightOutlined } from '@ant-design/icons'
import type { LibraryGame } from '@savedata-sync/shared'

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

  function startLongPress(event: PointerEvent<HTMLButtonElement>): void {
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

  function movePointer(event: PointerEvent<HTMLButtonElement>): void {
    const start = origin.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      cancelLongPress()
    }
  }

  function openContextMenu(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    cancelLongPress()
    if (!didLongPress.current) {
      didLongPress.current = true
      onOpenGame(game)
    }
  }

  function clickGame(event: MouseEvent<HTMLButtonElement>): void {
    if (didLongPress.current && event.detail !== 0) {
      event.preventDefault()
      didLongPress.current = false
      return
    }
    onOpenGame(game)
  }

  return (
    <button
      className="game-card"
      type="button"
      onClick={clickGame}
      onPointerDown={startLongPress}
      onPointerMove={movePointer}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={openContextMenu}
      onDragStart={(event) => event.preventDefault()}
    >
      <span className={`game-cover cover-${coverIndex % 3}`}>
        <FolderOutlined aria-hidden="true" />
        <strong>{game.name}</strong>
      </span>
      <span className="game-card-info">
        <strong>{game.name}</strong>
        <span>已关联 {game.links.length} 台设备</span>
        <RightOutlined />
      </span>
    </button>
  )
}
