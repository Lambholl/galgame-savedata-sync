import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { TaskStrip, useT } from '@savedata-sync/shared/ui'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import { EmptyState } from '../../components/EmptyState'
import { GameCard } from './GameCard'

/** 游戏页：游戏卡片列表、任务横条，以及添加和导入游戏的入口。 */
export function GamesPage({
  games,
  online,
  task,
  onOpenGame,
  onOpenTasks,
}: {
  readonly games: readonly LibraryGame[]
  readonly online: LibraryPeer | null
  readonly task: TaskStripInfo | null
  readonly onOpenGame: (game: LibraryGame) => void
  readonly onOpenTasks: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="connection-status">
        <span className={`status-dot ${online ? 'online' : ''}`} />
        {online ? t('app.connectedTo', { name: online.device.name }) : t('device.noneConnected')}
      </div>
      {task && <TaskStrip task={task} onOpen={onOpenTasks} />}
      {games.length ? (
        <div className="game-grid">
          {games.map((game, index) => (
            <GameCard key={game.id} game={game} coverIndex={index} onOpenGame={onOpenGame} />
          ))}
        </div>
      ) : (
        <EmptyState description={t('game.empty')} />
      )}
    </>
  )
}
