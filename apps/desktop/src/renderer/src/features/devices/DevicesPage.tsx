import { useState } from 'react'
import { Button, Card, Empty, Flex, InputNumber, Listy, Modal, Tag } from 'antd'
import { AndroidOutlined } from '@ant-design/icons'
import { createConnectionQrText, formatConnectionAddress } from '@savedata-sync/shared'
import type { LibraryPeer } from '@savedata-sync/shared'
import { ConnectionQr, ServiceHero, useT } from '@savedata-sync/shared/ui'
import type { ServiceHeroState } from '@savedata-sync/shared/ui'
import type { DesktopServiceView } from '../../platform/library-types.ts'

/** 设备页：上面是本机服务卡片，下面是已保存的设备列表。 */
export function DevicesPage({
  service,
  serviceChange,
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
  readonly service: DesktopServiceView | null
  /** 正在执行的启动或停止请求；没有时为 null。 */
  readonly serviceChange: 'starting' | 'stopping' | null
  readonly peers: readonly LibraryPeer[]
  /** 最近复制的地址，对应的复制按钮显示对勾。 */
  readonly copied: string
  /** 端口输入框的值；为 null 时输入框为空，不能启动服务。 */
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
  const [isQrOpen, setIsQrOpen] = useState(false)
  const listener = service?.listener ?? null
  // null 表示服务刚启动、还在读取本机地址。
  const addresses = service ? service.ipv4Addresses : []
  const recommended = addresses?.[0]
  const address = listener && recommended ? `${recommended}:${listener.port}` : null
  const qrText =
    service && listener && addresses?.length
      ? createConnectionQrText({ deviceId: service.deviceId, port: listener.port, addresses })
      : null
  const state: ServiceHeroState = serviceChange ?? (listener ? 'running' : 'stopped')
  const isPortValid = port !== null && Number.isInteger(port) && port >= 1 && port <= 65535
  return (
    <>
      {service && (
        <ServiceHero
          state={state}
          address={address}
          isAddressLoading={addresses === null}
          startedAt={listener?.startedAt ?? null}
          connectedName={peers.find((peer) => peer.isConnected)?.device.name ?? null}
          discovery={service.discovery.status}
          qrText={qrText}
          isCopied={address !== null && copied === address}
          isToggleDisabled={isDisabled || (!listener && !isPortValid)}
          portEditor={
            <Flex align="center" gap="small" className="library-port">
              {t('service.port')}
              <InputNumber
                size="large"
                aria-label={t('service.port')}
                min={1}
                max={65535}
                precision={0}
                value={port}
                readOnly={isBusy}
                onChange={onPortChange}
              />
              <Button size="large" disabled={isBusy} onClick={onRandomizePort}>
                {t('service.randomizePort')}
              </Button>
            </Flex>
          }
          onToggle={onToggleService}
          onCopy={() => address && onCopyAddress(address)}
          onShowQr={() => setIsQrOpen(true)}
        />
      )}
      <div className="library-section-heading">
        <h2>{t('device.saved')}</h2>
      </div>
      <Card className="library-device-list">
        {peers.length ? (
          <Listy<LibraryPeer>
            items={[...peers]}
            rowKey={(peer) => peer.device.id}
            itemRender={(peer) => (
              <Flex align="center" gap={12} className="library-device-row">
                <span className={`library-device-icon${peer.isConnected ? ' is-online' : ''}`}>
                  <AndroidOutlined />
                </span>
                <Flex vertical className="library-device-info">
                  <Flex align="center" gap="small">
                    <strong className="library-device-name ss-copyable">{peer.device.name}</strong>
                    {peer.isConnected && (
                      <Tag color="success" className="library-device-state">
                        {t('transfer.connected')}
                      </Tag>
                    )}
                  </Flex>
                  {/* 连着且没有地址时不写说明：标签已经写了“已连接”。 */}
                  {(peer.device.address || !peer.isConnected) && (
                    <span className="library-device-caption">
                      {peer.device.address
                        ? formatConnectionAddress(peer.device.address)
                        : t('device.waitingMobile')}
                    </span>
                  )}
                </Flex>
                {peer.isConnected && (
                  <Button
                    danger
                    disabled={isDisabled || isActive}
                    onClick={() => onDeviceAction(peer)}
                  >
                    {t('device.disconnect')}
                  </Button>
                )}
                <Button disabled={isDisabled} onClick={() => onManageDevice(peer.device.id)}>
                  {t('device.manage')}
                </Button>
              </Flex>
            )}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('device.emptyPc')} />
        )}
      </Card>
      <Modal
        title={t('service.qrTitle')}
        open={isQrOpen && qrText !== null}
        footer={null}
        width={340}
        onCancel={() => setIsQrOpen(false)}
      >
        {qrText && (
          <Flex vertical align="center" gap={12}>
            <ConnectionQr text={qrText} size={240} label={t('service.qrTitle')} />
            <span className="library-qr-address ss-copyable">{address}</span>
          </Flex>
        )}
      </Modal>
    </>
  )
}
