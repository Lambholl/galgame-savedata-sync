import {
  SwapOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  RightOutlined,
} from '@ant-design/icons'

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
  const actions = [
    { label: '目录设置', icon: <FolderOpenOutlined />, action: onSettings },
    { label: '备份与恢复', icon: <CloudDownloadOutlined />, action: onBackup },
    { label: '本次传输', icon: <HistoryOutlined />, action: onTasks },
    { label: '移除游戏', icon: <DeleteOutlined />, action: onRemove, isDanger: true },
  ]
  return (
    <div className="game-actions">
      <button className="game-action-main" type="button" onClick={onTransfer}>
        <span className="action-icon">
          <SwapOutlined />
        </span>
        <strong>传输存档</strong>
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
