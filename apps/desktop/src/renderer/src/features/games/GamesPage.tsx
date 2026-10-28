import { Button, Empty, Space, Typography } from 'antd'
import { DownloadOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { GameCard } from './GameCard.tsx'

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
      <div className="library-section-heading">
        <Typography.Text type="secondary">
          {online ? `${online.device.name} · 已连接` : '未连接设备'}
        </Typography.Text>
        <Space>
          <Button
            icon={<DownloadOutlined />}
            disabled={isDisabled || !hasImportableGames}
            onClick={onOpenImport}
          >
            导入游戏
          </Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={isDisabled} onClick={onAddGame}>
            添加游戏
          </Button>
        </Space>
      </div>
      {hasTasks && (
        <Button
          block
          icon={<SwapOutlined />}
          className="library-task-shortcut"
          onClick={onOpenTasks}
        >
          {isActive ? '查看任务进度' : '任务与结果'}
        </Button>
      )}
      {games.length ? (
        <div className="library-game-grid">
          {games.map((item, index) => (
            <GameCard key={item.id} game={item} coverIndex={index} onOpenGame={onOpenGame} />
          ))}
        </div>
      ) : (
        <Empty description="添加游戏并选择本机存档目录" />
      )}
    </>
  )
}
