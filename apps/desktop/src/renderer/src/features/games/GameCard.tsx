import { FolderOutlined, RightOutlined } from '@ant-design/icons'
import type { LibraryGame } from '@savedata-sync/shared'

/** 沿用手机卡片的封面与信息区；鼠标两键及键盘均打开本机游戏菜单。 */
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
    <button
      className="library-game-card"
      type="button"
      onClick={() => onOpenGame(game)}
      onContextMenu={(event) => {
        event.preventDefault()
        onOpenGame(game)
      }}
      onDragStart={(event) => event.preventDefault()}
    >
      <span className={`library-game-cover cover-${coverIndex % 3}`}>
        <FolderOutlined aria-hidden="true" />
        <strong>{game.name}</strong>
      </span>
      <span className="library-game-card-info">
        <strong>{game.name}</strong>
        <span>已关联 {game.links.length} 台设备</span>
        <RightOutlined aria-hidden="true" />
      </span>
    </button>
  )
}
