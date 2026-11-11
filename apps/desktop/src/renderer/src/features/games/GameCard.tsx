import type { LibraryGame } from '@savedata-sync/shared'
import { GameCard as SharedGameCard } from '@savedata-sync/shared/ui'

/** 桌面端的游戏卡片；右键打开游戏菜单。 */
export function GameCard({
  game,
  coverIndex,
  onOpenGame,
}: {
  readonly game: LibraryGame
  readonly coverIndex: number
  readonly onOpenGame: (game: LibraryGame) => void
}): React.JSX.Element {
  return (
    <div
      className="library-game-card"
      onContextMenu={(event) => {
        event.preventDefault()
        onOpenGame(game)
      }}
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
