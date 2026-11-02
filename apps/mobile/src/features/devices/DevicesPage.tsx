import { Button } from 'antd-mobile'
import { DesktopOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons'
import type { LibraryPeer } from '@savedata-sync/shared'
import { formatConnectionAddress } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
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
  const t = useT()
  return (
    <>
      <div className="section-heading">
        <h2>{t('device.saved')}</h2>
        <Button disabled={isDisabled || isActive} onClick={onAddDevice}>
          <PlusOutlined /> {t('device.addPc')}
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
                <h2 className="ss-copyable">{peer.device.name}</h2>
                <span className={`device-status ${peer.isConnected ? 'connected' : ''}`}>
                  {t(peer.isConnected ? 'transfer.connected' : 'transfer.disconnected')}
                </span>
              </div>
            </div>
            {peer.device.address && (
              <div className="device-address">
                <span className="ss-copyable">{formatConnectionAddress(peer.device.address)}</span>
                <Button
                  fill="none"
                  aria-label={t('device.copyAddress')}
                  onClick={() => onCopyAddress(peer.device.address ?? '')}
                >
                  <CopyOutlined />
                  {copied === peer.device.address ? ` ${t('common.copied')}` : ''}
                </Button>
              </div>
            )}
            <div className="action-row equal">
              <Button
                color={peer.isConnected ? 'danger' : 'primary'}
                disabled={isDisabled || isActive || (!peer.isConnected && Boolean(online))}
                onClick={() => onDeviceAction(peer)}
              >
                {t(peer.isConnected ? 'device.disconnect' : 'device.connect')}
              </Button>
              <Button disabled={isDisabled} onClick={() => onManageDevice(peer.device.id)}>
                {t('device.manage')}
              </Button>
            </div>
          </Panel>
        ))
      ) : (
        <EmptyState description={t('device.emptyPhone')} />
      )}
    </>
  )
}
