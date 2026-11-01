import { Button, Space } from 'antd'
import { SwapOutlined } from '@ant-design/icons'
import { useT } from '@savedata-sync/shared/ui'

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
  const t = useT()
  return (
    <Space orientation="vertical" className="library-full">
      <Button block type="primary" icon={<SwapOutlined />} onClick={onTransfer}>
        {t('page.transfer')}
      </Button>
      <Button block onClick={onSettings}>
        {t('page.gameSettings')}
      </Button>
      <Button block onClick={onBackup}>
        {t('page.backup')}
      </Button>
      <Button block onClick={onTasks}>
        {t('game.viewTasks')}
      </Button>
      <Button block danger disabled={isActive} onClick={onRemove}>
        {t('game.removeTitle')}
      </Button>
    </Space>
  )
}
