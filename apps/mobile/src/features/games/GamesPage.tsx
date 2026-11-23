import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { TaskStrip, useT } from '@savedata-sync/shared/ui'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import { EmptyState } from '../../components/EmptyState'
import { GameCard } from './GameCard'

/** 游戏页：游戏卡片列表、任务横条，以及添加和导入游戏的入口。 */
export function GamesPage({
  games,
  posterUrls,
  online,
  isConnectionKnown,
  task,
  onOpenGame,
  onOpenTasks,
}: {
  readonly games: readonly LibraryGame[]
  /** 键是游戏 ID 的封面图地址；没有的游戏显示占位封面。 */
  readonly posterUrls: ReadonlyMap<string, string>
  readonly online: LibraryPeer | null
  /** 还没读到连接状态时连接状态一行留空，不显示未连接。 */
  readonly isConnectionKnown: boolean
  readonly task: TaskStripInfo | null
  readonly onOpenGame: (game: LibraryGame) => void
  readonly onOpenTasks: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="connection-status">
        <span className={`status-dot ${online ? 'online' : ''}`} />
        {online
          ? t('app.connectedTo', { name: online.device.name })
          : isConnectionKnown
            ? t('device.noneConnected')
            : ' '}
      </div>
      {task ? <TaskStrip task={task} onOpen={onOpenTasks} /> : null}
      {games.length ? (
        <div className="game-grid">
          {games.map((game, index) => (
            <GameCard
              key={game.id}
              game={game}
              coverIndex={index}
              posterUrl={posterUrls.get(game.id) ?? null}
              onOpenGame={onOpenGame}
            />
          ))}
        </div>
      ) : (
        <EmptyState description={t('game.empty')} />
      )}
    </>
  )
}
