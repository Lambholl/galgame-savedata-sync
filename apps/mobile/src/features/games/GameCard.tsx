import type { LibraryGame } from '@savedata-sync/shared'
import { GameCard as SharedGameCard } from '@savedata-sync/shared/ui'
import { useLongPress } from '../../components/use-long-press'

/** 点击和长按打开同一个游戏菜单。 */
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
  const longPress = useLongPress(() => () => onOpenGame(game))
  return (
    <div className="game-card" {...longPress}>
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
