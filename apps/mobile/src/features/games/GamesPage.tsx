import { Button } from 'antd-mobile'
import { DownloadOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
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
  const t = useT()
  return (
    <>
      <div className="connection-status">
        <span className={`status-dot ${online ? 'online' : ''}`} />
        {online ? t('app.connectedTo', { name: online.device.name }) : t('device.noneConnected')}
      </div>
      <div className="action-row equal">
        <Button disabled={isDisabled || !hasImportableGames} onClick={onOpenImport}>
          <DownloadOutlined /> {t('game.importGame')}
        </Button>
        <Button color="primary" disabled={isDisabled} onClick={onAddGame}>
          <PlusOutlined /> {t('game.add')}
        </Button>
      </div>
      {hasTasks && (
        <Button block className="task-shortcut" onClick={onOpenTasks}>
          <SwapOutlined /> {t(isActive ? 'game.transferRunning' : 'game.viewTransferResult')}
        </Button>
      )}
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
