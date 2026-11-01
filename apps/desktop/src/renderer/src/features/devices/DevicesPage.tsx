import { Button, Card, Empty, Flex, InputNumber, Space, Tag } from 'antd'
import { AndroidOutlined } from '@ant-design/icons'
import type { LibraryPeer } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import type { DesktopSnapshot } from '../../platform/library-types.ts'
import { AddressField } from './AddressField.tsx'

export function DevicesPage({
  snapshot,
  peers,
  copied,
  port,
  isBusy,
  isDisabled,
  isActive,
  onPortChange,
  onRandomizePort,
  onToggleService,
  onCopyAddress,
  onDeviceAction,
  onManageDevice,
}: {
  readonly snapshot: DesktopSnapshot | null
  readonly peers: readonly LibraryPeer[]
  readonly copied: string
  readonly port: number | null
  readonly isBusy: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onPortChange: (value: number | null) => void
  readonly onRandomizePort: () => void
  readonly onToggleService: () => void
  readonly onCopyAddress: (address: string) => void
  readonly onDeviceAction: (peer: LibraryPeer) => void
  readonly onManageDevice: (id: string) => void
}): React.JSX.Element {
  const t = useT()
  const service = snapshot?.service
  return (
    <>
      {service && (
        <Card
          title={t('service.title')}
          extra={
            <Button
              disabled={
                isDisabled ||
                (!service.isRunning &&
                  (port === null || !Number.isInteger(port) || port < 1 || port > 65535))
              }
              onClick={onToggleService}
            >
              {t(service.isRunning ? 'service.stop' : 'service.start')}
            </Button>
          }
        >
          {service.addresses.map((address) => (
            <div className="library-address" key={address}>
              <AddressField address={address} copied={copied} onCopy={onCopyAddress} />
            </div>
          ))}
          <Flex align="center" className="library-port" gap="small">
            {t('service.portSettings')}
            <InputNumber
              aria-label={t('service.port')}
              min={1}
              max={65535}
              precision={0}
              value={port}
              readOnly={service.isRunning || isBusy}
              onChange={onPortChange}
            />
            <Button disabled={service.isRunning || isBusy} onClick={onRandomizePort}>
              {t('service.randomizePort')}
            </Button>
          </Flex>
        </Card>
      )}
      <div className="library-section-heading">
        <h2>{t('device.saved')}</h2>
      </div>
      {peers.length ? (
        <div className="library-device-grid">
          {peers.map((peer) => (
            <Card key={peer.device.id} className="library-device-card">
              <Flex align="flex-start" gap="small">
                <div className="library-device-icon">
                  <AndroidOutlined />
                </div>
                <Flex vertical className="library-device-info">
                  <Flex align="center" gap="small">
                    <strong className="library-device-name ss-copyable">{peer.device.name}</strong>
                    <Tag
                      color={peer.isConnected ? 'success' : 'default'}
                      className="library-device-state"
                    >
                      {t(peer.isConnected ? 'transfer.connected' : 'transfer.disconnected')}
                    </Tag>
                  </Flex>
                  {peer.device.address && (
                    <AddressField
                      address={peer.device.address}
                      copied={copied}
                      onCopy={onCopyAddress}
                    />
                  )}
                </Flex>
              </Flex>
              <Space wrap>
                <Button
                  danger={peer.isConnected}
                  disabled={isDisabled || isActive || !peer.isConnected}
                  onClick={() => onDeviceAction(peer)}
                >
                  {t(peer.isConnected ? 'device.disconnect' : 'device.waitingPhone')}
                </Button>
                <Button disabled={isDisabled} onClick={() => onManageDevice(peer.device.id)}>
                  {t('device.manage')}
                </Button>
              </Space>
            </Card>
          ))}
        </div>
      ) : (
        <Empty description={t('device.emptyPc')} />
      )}
    </>
  )
}
