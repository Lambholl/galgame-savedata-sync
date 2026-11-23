import type { LibraryGame } from '@savedata-sync/shared'
import { GameCard as SharedGameCard } from '@savedata-sync/shared/ui'

/** 桌面端的游戏卡片；右键打开游戏菜单。 */
export function GameCard({
  game,
  coverIndex,
  posterUrl,
  onOpenGame,
}: {
  readonly game: LibraryGame
  readonly coverIndex: number
  /** 封面图地址；没有封面或还没读出时为 null。 */
  readonly posterUrl: string | null
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
        posterUrl={posterUrl}
        onOpen={() => onOpenGame(game)}
      />
    </div>
  )
}
