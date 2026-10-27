import { Button, Card, Empty, Flex, InputNumber, Space, Tag } from 'antd'
import { AndroidOutlined } from '@ant-design/icons'
import type { LibraryPeer } from '@savedata-sync/shared'
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
  const service = snapshot?.service
  return (
    <>
      {service && (
        <Card
          title="本机服务"
          extra={
            <Button
              disabled={
                isDisabled ||
                (!service.isRunning &&
                  (port === null || !Number.isInteger(port) || port < 1 || port > 65535))
              }
              onClick={onToggleService}
            >
              {service.isRunning ? '停止' : '启动'}
            </Button>
          }
        >
          {service.addresses.map((address) => (
            <div className="library-address" key={address}>
              <AddressField address={address} copied={copied} onCopy={onCopyAddress} />
            </div>
          ))}
          <Flex align="center" style={{ margin: '16px 4px 0px' }} gap="small">
            端口设置
            <InputNumber
              aria-label="监听端口"
              min={1}
              max={65535}
              precision={0}
              value={port}
              readOnly={service.isRunning || isBusy}
              onChange={onPortChange}
            />
            <Button disabled={service.isRunning || isBusy} onClick={onRandomizePort}>
              随机生成
            </Button>
          </Flex>
        </Card>
      )}
      <div className="library-section-heading">
        <h2>已保存的设备</h2>
      </div>
      {peers.length ? (
        <div className="library-device-grid">
          {peers.map((peer) => (
            <Card key={peer.device.id} className="library-device-card">
              <Flex align="flex-start" gap="small">
                <div className="library-device-icon">
                  <AndroidOutlined />
                </div>
                <Flex vertical={true}>
                  <div style={{ fontWeight: 'bold' }}>{peer.device.name}</div>
                  {peer.device.address && (
                    <AddressField
                      address={peer.device.address}
                      copied={copied}
                      onCopy={onCopyAddress}
                    />
                  )}
                  <Tag
                    color={peer.isConnected ? 'success' : 'default'}
                    style={{ alignSelf: 'flex-start', flexShrink: 0 }}
                  >
                    {peer.isConnected ? '已连接' : '未连接'}
                  </Tag>
                </Flex>
              </Flex>
              <Space wrap>
                <Button
                  danger={peer.isConnected}
                  disabled={isDisabled || isActive || !peer.isConnected}
                  onClick={() => onDeviceAction(peer)}
                >
                  {peer.isConnected ? '断开' : '等待手机连接'}
                </Button>
                <Button disabled={isDisabled} onClick={() => onManageDevice(peer.device.id)}>
                  管理
                </Button>
              </Space>
            </Card>
          ))}
        </div>
      ) : (
        <Empty description="手机连接后会显示在这里" />
      )}
    </>
  )
}
