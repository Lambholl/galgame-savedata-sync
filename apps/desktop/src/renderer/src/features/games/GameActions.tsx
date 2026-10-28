import { Button, Space } from 'antd'
import { SwapOutlined } from '@ant-design/icons'

export function GameActions({
  isActive,
  onTransfer,
  onSettings,
  onBackup,
  onTasks,
  onRemove,
}: {
  readonly isActive: boolean
  readonly onTransfer: () => void
  readonly onSettings: () => void
  readonly onBackup: () => void
  readonly onTasks: () => void
  readonly onRemove: () => void
}): React.JSX.Element {
  return (
    <Space orientation="vertical" className="library-full">
      <Button block type="primary" icon={<SwapOutlined />} onClick={onTransfer}>
        传输存档
      </Button>
      <Button block onClick={onSettings}>
        目录设置
      </Button>
      <Button block onClick={onBackup}>
        备份与恢复
      </Button>
      <Button block onClick={onTasks}>
        任务与结果
      </Button>
      <Button block danger disabled={isActive} onClick={onRemove}>
        移除游戏
      </Button>
    </Space>
  )
}
