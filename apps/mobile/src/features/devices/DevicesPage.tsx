import { Button, List, SpinLoading } from 'antd-mobile'
import { AndroidOutlined, DesktopOutlined } from '@ant-design/icons'
import { formatConnectionAddress } from '@savedata-sync/shared'
import type { DeviceDescriptor, LibraryPeer } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { EmptyState } from '../../components/EmptyState'
import { useLongPress } from '../../components/use-long-press'
import type { DiscoveredDevice } from '../../platform/device-discovery'
import { useNearbyDevices } from './use-nearby-devices'

function PlatformIcon({
  platform,
}: {
  readonly platform: DeviceDescriptor['platform']
}): React.JSX.Element {
  return platform === 'windows' ? <DesktopOutlined /> : <AndroidOutlined />
}

/**
 * 行内的连接按钮。同一时间只连一台设备：已连上或正在连接一台设备时按钮变灰，点按后调用 onBlocked 提示先断开那台，
 * 不直接切换。不用 disabled，因为禁用的按钮点了没有反应，说不清为什么不能连。
 */
function ConnectButton({
  blockedBy,
  isDisabled,
  onConnect,
  onBlocked,
}: {
  readonly blockedBy: string | null
  readonly isDisabled: boolean
  readonly onConnect: () => void
  readonly onBlocked: (name: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Button
      size="small"
      color="primary"
      className={blockedBy === null ? undefined : 'device-connect-blocked'}
      aria-disabled={blockedBy !== null}
      disabled={isDisabled}
      onClick={(event) => {
        event.stopPropagation()
        if (blockedBy === null) {
          onConnect()
        } else {
          onBlocked(blockedBy)
        }
      }}
    >
      {t('device.connect')}
    </Button>
  )
}

/**
 * 设备页：已保存的设备和局域网里搜到的附近设备两组列表。页面打开期间一直在搜索，离开页面即停止。
 * 附近的设备只列还没保存的；已保存的设备在附近搜到时，在已保存的列表里标“在附近”，地址变了时显示搜到的地址。
 * 点按或长按已保存设备的整行打开管理。
 */
export function DevicesPage({
  peers,
  online,
  connectingId,
  isDisabled,
  isActive,
  onConnect,
  onDisconnect,
  onManageDevice,
  onConnectNearby,
  onBlocked,
}: {
  readonly peers: readonly LibraryPeer[]
  /** 当前连着的设备；没有连接时为 null。 */
  readonly online: LibraryPeer | null
  /** 正在连接的设备 ID，可能是已保存的设备，也可能是附近的设备；没有时为 null。 */
  readonly connectingId: string | null
  readonly isDisabled: boolean
  readonly isActive: boolean
  /**
   * 连接已保存的设备。附近搜到了这台设备、搜到的地址里却没有保存的地址时，moved 是搜到的设备，否则为 null。
   */
  readonly onConnect: (peer: LibraryPeer, moved: DiscoveredDevice | null) => void
  readonly onDisconnect: (peer: LibraryPeer) => void
  readonly onManageDevice: (id: string) => void
  readonly onConnectNearby: (device: DiscoveredDevice) => void
  /** 已有连接时点了连接，提示先断开 name 那台设备。 */
  readonly onBlocked: (name: string) => void
}): React.JSX.Element {
  const t = useT()
  const nearby = useNearbyDevices()
  const savedIds = new Set(peers.map((peer) => peer.device.id))
  const nearbyDevices = nearby.snapshot.devices.filter((device) => !savedIds.has(device.deviceId))
  const nearbySaved = new Map(
    nearby.snapshot.devices
      .filter((device) => savedIds.has(device.deviceId))
      .map((device) => [device.deviceId, device]),
  )
  /** 判断附近搜到的地址里有没有这台设备保存的地址。 */
  function isAtSavedAddress(peer: LibraryPeer, device: DiscoveredDevice): boolean {
    const saved = peer.device.address && formatConnectionAddress(peer.device.address)
    return device.addresses.some((address) => `${address}:${device.port}` === saved)
  }
  const blockedBy =
    online?.device.name ??
    peers.find((peer) => peer.device.id === connectingId)?.device.name ??
    nearby.snapshot.devices.find((device) => device.deviceId === connectingId)?.name ??
    null
  const isSearching = nearby.snapshot.status === 'searching'
  // 长按已保存设备的整行和点按一样打开管理；从行内按钮开始的长按不算，避免按住“连接”时弹出菜单。
  const longPress = useLongPress((target) => {
    const id = target.closest('[data-device-id]')?.getAttribute('data-device-id')
    return id && !target.closest('button') ? () => onManageDevice(id) : null
  })
  return (
    <>
      {peers.length ? (
        <div className="device-saved" {...longPress}>
          <List mode="card" header={t('device.saved')} className="device-list">
            {peers.map((peer) => {
              const isConnecting = connectingId === peer.device.id
              const address = peer.device.address && formatConnectionAddress(peer.device.address)
              const found = nearbySaved.get(peer.device.id)
              // 附近搜到的地址里没有保存的地址时，显示搜到的地址：点“连接”会连它，连上后保存的地址换成它。
              const moved = found !== undefined && !isAtSavedAddress(peer, found) ? found : null
              const nearbyAddress = moved ? `${moved.addresses[0] ?? ''}:${moved.port}` : address
              return (
                <List.Item
                  key={peer.device.id}
                  data-device-id={peer.device.id}
                  prefix={
                    <span className={`device-icon${peer.isConnected ? ' is-online' : ''}`}>
                      <DesktopOutlined />
                    </span>
                  }
                  description={
                    peer.isConnected ? (
                      <span className="device-ok">
                        {address
                          ? `${t('transfer.connected')} · ${address}`
                          : t('transfer.connected')}
                      </span>
                    ) : isConnecting ? (
                      t('device.connecting')
                    ) : found !== undefined ? (
                      <span className="device-inline">
                        <span className="device-near">{t('device.nearbyHere')}</span>
                        {nearbyAddress}
                      </span>
                    ) : (
                      address
                    )
                  }
                  arrow={false}
                  extra={
                    peer.isConnected ? (
                      <Button
                        size="small"
                        color="danger"
                        fill="outline"
                        disabled={isDisabled || isActive}
                        onClick={(event) => {
                          event.stopPropagation()
                          onDisconnect(peer)
                        }}
                      >
                        {t('device.disconnect')}
                      </Button>
                    ) : isConnecting ? (
                      <SpinLoading style={{ '--size': '20px' }} />
                    ) : peer.device.address ? (
                      <ConnectButton
                        blockedBy={blockedBy}
                        isDisabled={isDisabled || isActive}
                        onConnect={() => onConnect(peer, moved)}
                        onBlocked={onBlocked}
                      />
                    ) : undefined
                  }
                  onClick={() => onManageDevice(peer.device.id)}
                >
                  {peer.device.name}
                </List.Item>
              )
            })}
          </List>
        </div>
      ) : (
        <EmptyState description={t('device.emptyMobile')} />
      )}
      {nearby.snapshot.status !== 'unavailable' && (
        <List
          mode="card"
          className="device-list"
          header={
            <span className="device-inline">
              {t('device.nearby')}
              {isSearching && <SpinLoading style={{ '--size': '12px' }} />}
            </span>
          }
        >
          {nearbyDevices.map((device) => (
            <List.Item
              key={device.deviceId}
              prefix={
                <span className="device-icon">
                  <PlatformIcon platform={device.platform} />
                </span>
              }
              description={`${device.addresses[0] ?? ''}:${device.port}`}
              arrow={false}
              extra={
                connectingId === device.deviceId ? (
                  <SpinLoading style={{ '--size': '20px' }} />
                ) : (
                  <ConnectButton
                    blockedBy={blockedBy}
                    isDisabled={isDisabled || isActive}
                    onConnect={() => onConnectNearby(device)}
                    onBlocked={onBlocked}
                  />
                )
              }
            >
              {device.name}
            </List.Item>
          ))}
          {nearby.snapshot.incompatibleNames.map((name) => (
            <List.Item
              key={`outdated-${name}`}
              disabled
              description={<span className="device-warn">{t('device.nearbyOutdated')}</span>}
              arrow={false}
            >
              {name}
            </List.Item>
          ))}
          {nearby.snapshot.status === 'failed' ? (
            <List.Item
              arrow={false}
              extra={
                <Button size="small" onClick={nearby.retry}>
                  {t('common.retry')}
                </Button>
              }
            >
              <span className="device-muted">{t('device.nearbyFailed')}</span>
            </List.Item>
          ) : (
            nearby.isSettled &&
            nearbyDevices.length === 0 &&
            nearby.snapshot.incompatibleNames.length === 0 && (
              <List.Item arrow={false}>
                <span className="device-muted">{t('device.nearbyEmpty')}</span>
              </List.Item>
            )
          )}
        </List>
      )}
    </>
  )
}
