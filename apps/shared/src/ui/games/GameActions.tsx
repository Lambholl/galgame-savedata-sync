import type { ReactElement } from 'react'
import { Button } from 'antd'
import {
  ControlOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  HistoryOutlined,
  RightOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { useT } from '../i18n/i18n-context.ts'
import './games.css'

/** GameActions 的参数。 */
export interface GameActionsProps {
  /** 本机目录及关联设备的摘要。 */
  readonly caption: string
  /** 为 true 时禁用移除游戏。 */
  readonly isRemoveDisabled: boolean
  /** 打开传输存档。 */
  readonly onTransfer: () => void
  /** 打开游戏设置。 */
  readonly onSettings: () => void
  /** 打开本游戏的备份与恢复。 */
  readonly onBackup: () => void
  /** 打开本游戏的传输详情。 */
  readonly onTasks: () => void
  /** 点按移除游戏。 */
  readonly onRemove: () => void
}

/** 游戏操作面板的内容：主操作“传输存档”，下方是设置、备份、传输详情和移除四项。 */
export function GameActions({
  caption,
  isRemoveDisabled,
  onTransfer,
  onSettings,
  onBackup,
  onTasks,
  onRemove,
}: GameActionsProps): ReactElement {
  const t = useT()
  const actions = [
    {
      key: 'settings',
      label: t('page.gameSettings'),
      icon: <ControlOutlined />,
      onClick: onSettings,
    },
    {
      key: 'backup',
      label: t('page.backup'),
      icon: <CloudDownloadOutlined />,
      onClick: onBackup,
    },
    {
      key: 'task',
      label: t('page.task'),
      icon: <HistoryOutlined />,
      onClick: onTasks,
    },
    {
      key: 'remove',
      label: t('game.removeTitle'),
      icon: <DeleteOutlined />,
      onClick: onRemove,
    },
  ]
  return (
    <div className="ss-game-actions">
      <p className="ss-game-caption">{caption}</p>
      <Button type="primary" block className="ss-game-primary" onClick={onTransfer}>
        <SwapOutlined className="ss-game-transfer-icon" />
        <strong>{t('page.transfer')}</strong>
        <RightOutlined />
      </Button>
      <div className="ss-game-action-grid">
        {actions.map((item) => (
          <Button
            key={item.key}
            variant="filled"
            danger={item.key === 'remove'}
            className={`ss-game-action${item.key === 'remove' ? ' is-danger' : ''}`}
            disabled={item.key === 'remove' && isRemoveDisabled}
            onClick={item.onClick}
          >
            {item.icon}
            <b>{item.label}</b>
          </Button>
        ))}
      </div>
    </div>
  )
}
