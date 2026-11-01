import { Button, Empty, Space, Typography } from 'antd'
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { TaskStrip, useT } from '@savedata-sync/shared/ui'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import { GameCard } from './GameCard.tsx'

export function GamesPage({
  games,
  online,
  task,
  hasImportableGames,
  isDisabled,
  onOpenGame,
  onOpenImport,
  onAddGame,
  onOpenTasks,
}: {
  readonly games: readonly LibraryGame[]
  readonly online: LibraryPeer | null
  readonly task: TaskStripInfo | null
  readonly hasImportableGames: boolean
  readonly isDisabled: boolean
  readonly onOpenGame: (game: LibraryGame) => void
  readonly onOpenImport: () => void
  readonly onAddGame: () => void
  readonly onOpenTasks: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="library-section-heading">
        <Typography.Text type="secondary">
          {online ? t('app.connectedTo', { name: online.device.name }) : t('device.noneConnected')}
        </Typography.Text>
        <Space>
          <Button
            icon={<DownloadOutlined />}
            disabled={isDisabled || !hasImportableGames}
            onClick={onOpenImport}
          >
            {t('game.importGame')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={isDisabled} onClick={onAddGame}>
            {t('game.add')}
          </Button>
        </Space>
      </div>
      {task && <TaskStrip task={task} onOpen={onOpenTasks} />}
      {games.length ? (
        <div className="library-game-grid">
          {games.map((item, index) => (
            <GameCard key={item.id} game={item} coverIndex={index} onOpenGame={onOpenGame} />
          ))}
        </div>
      ) : (
        <Empty description={t('game.empty')} />
      )}
    </>
  )
}
