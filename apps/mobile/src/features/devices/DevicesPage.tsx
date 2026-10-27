import { Button } from 'antd-mobile'
import { DesktopOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons'
import type { LibraryPeer } from '@savedata-sync/shared'
import { EmptyState } from '../../components/EmptyState'
import { Panel } from '../../components/Panel'

export function DevicesPage({
  peers,
  online,
  copied,
  isDisabled,
  isActive,
  onCopyAddress,
  onAddDevice,
  onDeviceAction,
  onManageDevice,
}: {
  readonly peers: readonly LibraryPeer[]
  readonly online: LibraryPeer | null
  readonly copied: string
  readonly isBusy: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onCopyAddress: (address: string) => void
  readonly onAddDevice: () => void
  readonly onDeviceAction: (peer: LibraryPeer) => void
  readonly onManageDevice: (id: string) => void
}): React.JSX.Element {
  return (
    <>
      <div className="section-heading">
        <h2>已保存的设备</h2>
        <Button disabled={isDisabled || isActive} onClick={onAddDevice}>
          <PlusOutlined /> 添加电脑
        </Button>
      </div>
      {peers.length ? (
        peers.map((peer) => (
          <Panel key={peer.device.id}>
            <div className="device-heading">
              <span className="device-icon">
                <DesktopOutlined />
              </span>
              <div>
                <h2>{peer.device.name}</h2>
                <span className={`device-status ${peer.isConnected ? 'connected' : ''}`}>
                  {peer.isConnected ? '已连接' : peer.device.blocked ? '已断开' : '未连接'}
                </span>
              </div>
            </div>
            {peer.device.address && (
              <div className="device-address">
                <span>{peer.device.address}</span>
                <Button
                  fill="none"
                  aria-label="复制电脑地址"
                  onClick={() => onCopyAddress(peer.device.address ?? '')}
                >
                  <CopyOutlined />
                  {copied === peer.device.address ? ' 已复制' : ''}
                </Button>
              </div>
            )}
            <div className="action-row equal">
              <Button
                color={peer.isConnected ? 'danger' : 'primary'}
                disabled={isDisabled || isActive || (!peer.isConnected && Boolean(online))}
                onClick={() => onDeviceAction(peer)}
              >
                {peer.isConnected ? '断开' : '连接'}
              </Button>
              <Button disabled={isDisabled} onClick={() => onManageDevice(peer.device.id)}>
                管理
              </Button>
            </div>
          </Panel>
        ))
      ) : (
        <EmptyState description="添加电脑地址后连接" />
      )}
    </>
  )
}
