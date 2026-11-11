import type { ReactElement, ReactNode } from 'react'
import { DesktopOutlined, MobileOutlined } from '@ant-design/icons'
import { PathText } from '../path-text/PathText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import './devices.css'

/** 关联到当前游戏的一台设备。 */
export interface LinkedDevice {
  /** 设备 ID。 */
  readonly deviceId: string
  /** 设备名；设备已移除时是“设备已移除”的本地化文字。 */
  readonly name: string
  /** 设备类型，决定图标。 */
  readonly kind: 'pc' | 'mobile'
  /** 是否已连接，决定状态点颜色。 */
  readonly isConnected: boolean
  /** 对方的游戏名；读不到时为 null。 */
  readonly gameName: string | null
  /** 对方游戏的目录；未选择或读不到时为 null。 */
  readonly path: string | null
  /** 设备已从设备列表中移除，只剩关联记录。 */
  readonly isRemoved: boolean
}

/** LinkedDeviceList 的参数。 */
export interface LinkedDeviceListProps {
  /** 要列出的关联设备，按显示顺序。 */
  readonly items: readonly LinkedDevice[]
  /** 渲染每行末尾的操作，如传输按钮和菜单按钮。 */
  readonly actions: (item: LinkedDevice) => ReactNode
}

function caption(item: LinkedDevice, t: ReturnType<typeof useT>): ReactNode {
  if (item.isRemoved) {
    return item.gameName
  }
  const prefix = item.gameName ? `${item.gameName} · ` : ''
  if (!item.isConnected) {
    return prefix + t('game.offline')
  }
  return item.path ? <PathText path={prefix + item.path} /> : prefix + t('game.noRemoteFolder')
}

/** 关联设备列表：每行是状态点、对方的游戏名和目录；未连接的设备说明连接后才显示目录。 */
export function LinkedDeviceList({ items, actions }: LinkedDeviceListProps): ReactElement {
  const t = useT()
  if (!items.length) {
    return <p className="ss-list-empty">{t('game.noLinks')}</p>
  }
  return (
    <div className="ss-list">
      {items.map((item) => (
        <div className="ss-list-row" key={item.deviceId}>
          <span className="ss-list-lead">
            {item.kind === 'pc' ? <DesktopOutlined /> : <MobileOutlined />}
            <i className={`ss-list-dot${item.isConnected ? ' is-on' : ''}`} />
          </span>
          <span className="ss-list-body">
            <b className={item.isRemoved ? 'is-faint' : undefined}>{item.name}</b>
            <small>{caption(item, t)}</small>
          </span>
          <span className="ss-list-end">{actions(item)}</span>
        </div>
      ))}
    </div>
  )
}
