import { useState } from 'react'
import { Button, Card, Empty, Flex, InputNumber, Modal, Spin, Tooltip } from 'antd'
import { AndroidOutlined, DesktopOutlined, PlusOutlined } from '@ant-design/icons'
import { createConnectionQrText, formatConnectionAddress } from '@savedata-sync/shared'
import type { DeviceDescriptor, LibraryPeer } from '@savedata-sync/shared'
import { ConnectionQr, ServiceHero, ShuffleIcon, useT } from '@savedata-sync/shared/ui'
import type { ServiceHeroState } from '@savedata-sync/shared/ui'
import type {
  DesktopDialerSnapshot,
  DesktopNearbyDevice,
} from '../../../../bridge/dialer-bridge.ts'
import type { DesktopServiceView } from '../../platform/library-types.ts'

function PlatformIcon({
  platform,
}: {
  readonly platform: DeviceDescriptor['platform']
}): React.JSX.Element {
  return platform === 'windows' ? <DesktopOutlined /> : <AndroidOutlined />
}

/** 连接按钮。blockedBy 不为 null 时禁用，悬停提示先断开那台设备。 */
function ConnectButton({
  blockedBy,
  isLoading,
  isDisabled,
  onConnect,
}: {
  readonly blockedBy: string | null
  readonly isLoading: boolean
  readonly isDisabled: boolean
  readonly onConnect: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Tooltip
      title={blockedBy && !isLoading ? t('device.disconnectFirst', { name: blockedBy }) : undefined}
    >
      <Button
        type="primary"
        loading={isLoading}
        disabled={!isLoading && (blockedBy !== null || isDisabled)}
        onClick={onConnect}
      >
        {t('device.connect')}
      </Button>
    </Tooltip>
  )
}

/** 附近设备的 `IP:端口`，取第一个地址。 */
function nearbyAddress(device: DesktopNearbyDevice): string {
  return `${device.addresses[0] ?? ''}:${device.port}`
}

/** 设备页：上面是本机服务卡片，下面是已保存的设备和附近的设备。 */
export function DevicesPage({
  service,
  serviceChange,
  peers,
  dialer,
  connectingId,
  copied,
  port,
  isBusy,
  isDisabled,
  isActive,
  onPortChange,
  onRandomizePort,
  onToggleService,
  onCopyAddress,
  onAddDevice,
  onConnectSaved,
  onConnectNearby,
  onDeviceAction,
  onManageDevice,
}: {
  readonly service: DesktopServiceView | null
  /** 正在执行的启动或停止请求；没有时为 null。 */
  readonly serviceChange: 'starting' | 'stopping' | null
  readonly peers: readonly LibraryPeer[]
  /** 本机拨号的连接和附近的设备；还没读到时为 null。 */
  readonly dialer: DesktopDialerSnapshot | null
  /** 正在连接的已保存或附近设备的 ID，它的连接按钮显示加载中；没有时为 null。 */
  readonly connectingId: string | null
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
  /** 点“添加设备”时触发。 */
  readonly onAddDevice: () => void
  readonly onConnectSaved: (peer: LibraryPeer) => void
  readonly onConnectNearby: (device: DesktopNearbyDevice) => void
  /** 点已连接设备的“断开”时触发。 */
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
  const session = dialer?.session ?? null
  const nearby = dialer?.nearby ?? null
  const found = new Map(nearby?.devices.map((device) => [device.deviceId, device]))
  const nearbyDevices =
    nearby?.devices.filter((device) => !peers.some((peer) => peer.device.id === device.deviceId)) ??
    []
  const online = peers.find((peer) => peer.isConnected) ?? null
  const nameOf = (id: string): string | null =>
    peers.find((peer) => peer.device.id === id)?.device.name ?? found.get(id)?.name ?? null
  // 同一时间只连一台设备：连进本机的，或本机连着（包括正在重连）的那台。
  const blockedBy = online?.device.name ?? (session ? nameOf(session.deviceId) : null)
  return (
    <>
      {service ? (
        <ServiceHero
          state={state}
          address={address}
          isAddressLoading={addresses === null}
          startedAt={listener?.startedAt ?? null}
          discovery={service.discovery.status}
          qrText={qrText}
          isCopied={address !== null && copied === address}
          isToggleDisabled={isDisabled || (!listener && !isPortValid)}
          portEditor={
            <Flex align="center" wrap gap="small" className="library-port">
              <span className="library-port-label">{t('service.port')}</span>
              <Flex align="center" gap="small">
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
                <Tooltip title={t('service.randomizePort')}>
                  <Button
                    size="large"
                    icon={<ShuffleIcon />}
                    aria-label={t('service.randomizePort')}
                    disabled={isBusy}
                    onClick={onRandomizePort}
                  />
                </Tooltip>
              </Flex>
            </Flex>
          }
          isCompact={false}
          onToggle={onToggleService}
          onCopy={() => address && onCopyAddress(address)}
          onShowQr={() => setIsQrOpen(true)}
        />
      ) : null}
      <div className="library-section-heading">
        <h2>{t('device.saved')}</h2>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={isDisabled || blockedBy !== null}
          onClick={onAddDevice}
        >
          {t('device.addPc')}
        </Button>
      </div>
      <Card className="library-device-list">
        {peers.length ? (
          <Flex vertical>
            {peers.map((peer) => {
              const id = peer.device.id
              const isDialed = session?.deviceId === id
              const nearbyHere = found.get(id)
              const caption = nearbyHere
                ? nearbyAddress(nearbyHere)
                : peer.device.address
                  ? formatConnectionAddress(peer.device.address)
                  : peer.isConnected
                    ? null
                    : t('device.waitingMobile')
              return (
                <Flex key={id} align="center" gap={12} className="library-device-row">
                  <span
                    className={`library-device-icon${peer.isConnected ? ' is-connected' : nearbyHere ? '' : ' is-offline'}`}
                  >
                    <PlatformIcon platform={peer.device.platform} />
                  </span>
                  <Flex vertical className="library-device-info">
                    <strong className="library-device-name ss-copyable">{peer.device.name}</strong>
                    {caption ? <span className="library-device-caption">{caption}</span> : null}
                  </Flex>
                  {peer.isConnected || isDialed ? (
                    <Button
                      danger
                      disabled={isDisabled || isActive}
                      onClick={() => onDeviceAction(peer)}
                    >
                      {t('device.disconnect')}
                    </Button>
                  ) : peer.device.address || nearbyHere ? (
                    <ConnectButton
                      blockedBy={blockedBy}
                      isLoading={connectingId === id}
                      isDisabled={isDisabled || peer.device.isBlocked}
                      onConnect={() => onConnectSaved(peer)}
                    />
                  ) : null}
                  <Button disabled={isDisabled} onClick={() => onManageDevice(id)}>
                    {t('device.manage')}
                  </Button>
                </Flex>
              )
            })}
          </Flex>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('device.emptyPc')} />
        )}
      </Card>
      <div className="library-section-heading">
        <Flex component="h2" align="center" gap="small">
          {t('device.nearby')}
          {nearby?.status === 'searching' ? <Spin size="small" /> : null}
        </Flex>
      </div>
      <Card className="library-device-list">
        {nearby?.status === 'failed' ? (
          <span className="library-device-caption">{t('device.nearbyFailed')}</span>
        ) : nearbyDevices.length || nearby?.incompatibleNames.length ? (
          <Flex vertical>
            {nearbyDevices.map((device) => (
              <Flex key={device.deviceId} align="center" gap={12} className="library-device-row">
                <span className="library-device-icon">
                  <PlatformIcon platform={device.platform} />
                </span>
                <Flex vertical className="library-device-info">
                  <strong className="library-device-name ss-copyable">{device.name}</strong>
                  <span className="library-device-caption">{nearbyAddress(device)}</span>
                </Flex>
                <ConnectButton
                  blockedBy={blockedBy}
                  isLoading={connectingId === device.deviceId}
                  isDisabled={isDisabled}
                  onConnect={() => onConnectNearby(device)}
                />
              </Flex>
            ))}
            {nearby?.incompatibleNames.map((name) => (
              <Flex key={`outdated-${name}`} align="center" gap={12} className="library-device-row">
                <span className="library-device-icon">
                  <DesktopOutlined />
                </span>
                <Flex vertical className="library-device-info">
                  <strong className="library-device-name ss-copyable">{name}</strong>
                  <span className="library-device-caption">{t('device.nearbyOutdated')}</span>
                </Flex>
              </Flex>
            ))}
          </Flex>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('device.nearbyEmpty')} />
        )}
      </Card>
      <Modal
        title={t('service.qrTitle')}
        open={qrText !== null && isQrOpen}
        footer={null}
        width={340}
        onCancel={() => setIsQrOpen(false)}
      >
        {qrText ? (
          <Flex vertical align="center" gap={12}>
            <ConnectionQr text={qrText} size={240} label={t('service.qrTitle')} />
            <span className="library-qr-address ss-copyable">{address}</span>
          </Flex>
        ) : null}
      </Modal>
    </>
  )
}
