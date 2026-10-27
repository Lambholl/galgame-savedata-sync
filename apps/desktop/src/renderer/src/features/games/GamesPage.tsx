import { Button, Card, Empty, Space, Typography } from 'antd'
import { DownloadOutlined, FolderOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'

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
          {isActive ? '传输进行中' : '查看传输结果'}
        </Button>
      )}
      {games.length ? (
        <div className="library-game-grid">
          {games.map((item, index) => (
            <Card
              key={item.id}
              hoverable
              className="library-game-card"
              onClick={() => onOpenGame(item)}
              onContextMenu={(event) => {
                event.preventDefault()
                onOpenGame(item)
              }}
            >
              <Button type="text" block className={`library-game-cover cover-${index % 3}`}>
                <FolderOutlined />
                <strong>{item.name}</strong>
              </Button>
              <h3>{item.name}</h3>
              <Typography.Text type="secondary">已关联 {item.links.length} 台设备</Typography.Text>
            </Card>
          ))}
        </div>
      ) : (
        <Empty description="添加游戏并选择本机存档目录" />
      )}
    </>
  )
}
