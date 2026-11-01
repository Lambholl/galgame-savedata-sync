import {
  SwapOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  RightOutlined,
} from '@ant-design/icons'
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
  const actions = [
    { label: t('page.gameSettings'), icon: <FolderOpenOutlined />, action: onSettings },
    { label: t('page.backup'), icon: <CloudDownloadOutlined />, action: onBackup },
    { label: t('page.task'), icon: <HistoryOutlined />, action: onTasks },
    { label: t('game.removeTitle'), icon: <DeleteOutlined />, action: onRemove, isDanger: true },
  ]
  return (
    <div className="game-actions">
      <button className="game-action-main" type="button" onClick={onTransfer}>
        <span className="action-icon">
          <SwapOutlined />
        </span>
        <strong>{t('page.transfer')}</strong>
        <RightOutlined />
      </button>
      <div className="game-action-grid">
        {actions.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`game-action-card ${item.isDanger ? 'danger' : ''}`}
            disabled={item.isDanger && isActive}
            onClick={item.action}
          >
            {item.icon}
            <span>{item.label}</span>
            {!item.isDanger && <RightOutlined />}
          </button>
        ))}
      </div>
    </div>
  )
}
