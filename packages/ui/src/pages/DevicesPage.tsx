import { Button, Card, Empty, Flex, InputNumber, Space, Tag, Typography } from 'antd'
import { AndroidOutlined, DesktopOutlined, PlusOutlined } from '@ant-design/icons'
import type { LibraryPeer } from '@savedata-sync/shared'
import type { UiSnapshot } from '../api.ts'
import { AddressField } from '../components/AddressField.tsx'

export function DevicesPage({
  snapshot,
  peers,
  online,
  copied,
  port,
  isMobile,
  isBusy,
  isDisabled,
  isActive,
  onPortChange,
  onToggleService,
  onCopyAddress,
  onAddDevice,
  onDeviceAction,
  onManageDevice,
}: {
  readonly snapshot: UiSnapshot | null
  readonly peers: readonly LibraryPeer[]
  readonly online: LibraryPeer | null
  readonly copied: string
  readonly port: number | null
  readonly isMobile: boolean
  readonly isBusy: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onPortChange: (value: number | null) => void
  readonly onToggleService: () => void
  readonly onCopyAddress: (address: string) => void
  readonly onAddDevice: () => void
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
            <Button disabled={isDisabled} onClick={onToggleService}>
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
              min={0}
              max={65535}
              precision={0}
              value={port}
              disabled={service.isRunning || isBusy}
              onChange={onPortChange}
            />
            <Typography.Text type="secondary"> 0 为自动分配</Typography.Text>
          </Flex>
        </Card>
      )}
      <div className="library-section-heading">
        <h2>已保存的设备</h2>
        {isMobile && (
          <Button icon={<PlusOutlined />} disabled={isDisabled || isActive} onClick={onAddDevice}>
            添加电脑
          </Button>
        )}
      </div>
      {peers.length ? (
        <div className="library-device-grid">
          {peers.map((peer) => (
            <Card key={peer.device.id} className="library-device-card">
              <Flex align="flex-start" gap="small">
                <div className="library-device-icon">
                  {isMobile ? <DesktopOutlined /> : <AndroidOutlined />}
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
                  <Tag color={peer.isConnected ? 'success' : 'default'}>
                    {peer.isConnected ? '已连接' : peer.device.blocked ? '已断开' : '未连接'}
                  </Tag>
                </Flex>
              </Flex>
              <Space wrap>
                <Button
                  disabled={
                    isDisabled || isActive || (!peer.isConnected && isMobile && Boolean(online))
                  }
                  onClick={() => onDeviceAction(peer)}
                >
                  {peer.isConnected
                    ? '断开'
                    : isMobile
                      ? '连接'
                      : peer.device.blocked
                        ? '允许连接'
                        : '等待手机连接'}
                </Button>
                <Button disabled={isDisabled} onClick={() => onManageDevice(peer.device.id)}>
                  管理
                </Button>
              </Space>
            </Card>
          ))}
        </div>
      ) : (
        <Empty description={isMobile ? '添加电脑地址后连接' : '手机连接后会显示在这里'} />
      )}
    </>
  )
}
