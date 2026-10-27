import { Button } from 'antd-mobile'
import { DownloadOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { EmptyState } from '../../components/EmptyState'
import { GameCard } from './GameCard'

export function GamesPage({
  games,
  online,
  hasTasks,
  hasImportableGames,
  isDisabled,
  isActive,
  onOpenGame,
  onOpenImport,
  onAddGame,
  onOpenTasks,
}: {
  readonly games: readonly LibraryGame[]
  readonly online: LibraryPeer | null
  readonly hasTasks: boolean
  readonly hasImportableGames: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onOpenGame: (game: LibraryGame) => void
  readonly onOpenImport: () => void
  readonly onAddGame: () => void
  readonly onOpenTasks: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="connection-status">
        <span className={`status-dot ${online ? 'online' : ''}`} />
        {online ? `${online.device.name} · 已连接` : '未连接设备'}
      </div>
      <div className="action-row equal">
        <Button disabled={isDisabled || !hasImportableGames} onClick={onOpenImport}>
          <DownloadOutlined /> 导入游戏
        </Button>
        <Button color="primary" disabled={isDisabled} onClick={onAddGame}>
          <PlusOutlined /> 添加游戏
        </Button>
      </div>
      {hasTasks && (
        <Button block className="task-shortcut" onClick={onOpenTasks}>
          <SwapOutlined /> {isActive ? '传输进行中' : '查看传输结果'}
        </Button>
      )}
      {games.length ? (
        <div className="game-grid">
          {games.map((game, index) => (
            <GameCard key={game.id} game={game} coverIndex={index} onOpenGame={onOpenGame} />
          ))}
        </div>
      ) : (
        <EmptyState description="添加游戏并选择本机存档目录" />
      )}
    </>
  )
}
