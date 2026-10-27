import { Button, Switch } from 'antd-mobile'
import type {
  CatalogGame,
  DirectoryLocation,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter } from '../../platform/library-types'
import { Panel } from '../../components/Panel'
import { ChoiceField } from '../../components/ChoiceField'
import { DirectoryPane } from './DirectoryPane'

export function TransferPage({
  adapter,
  game,
  peers,
  selectedPeer,
  remoteGame,
  localRoot,
  peerId,
  upload,
  isDisabled,
  isActive,
  onPeerChange,
  onUploadChange,
  onLocalLocation,
  onRemoteLocation,
  onOpenSettings,
}: {
  readonly adapter: MobileLibraryAdapter
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly selectedPeer: LibraryPeer | null
  readonly remoteGame: CatalogGame | undefined
  readonly localRoot: DirectoryReference | null
  readonly peerId: string
  readonly upload: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onPeerChange: (id: string) => void
  readonly onUploadChange: (isUpload: boolean) => void
  readonly onLocalLocation: (value: DirectoryLocation | null) => void
  readonly onRemoteLocation: (value: DirectoryLocation | null) => void
  readonly onOpenSettings: () => void
}): React.JSX.Element {
  const isLocked = isDisabled || isActive
  return (
    <>
      <Panel>
        <ChoiceField
          label="对端设备"
          value={selectedPeer ? peerId : ''}
          isDisabled={isLocked}
          options={game.links.map((link) => {
            const peer = peers.find((item) => item.device.id === link.deviceId)
            return {
              value: link.deviceId,
              label: `${peer?.device.name ?? '未知设备'} · ${peer?.isConnected ? '已连接' : '未连接'}`,
            }
          })}
          onChange={onPeerChange}
        />
      </Panel>
      <div className="direction-picker" role="group" aria-label="传输方向">
        <Button
          color={!upload ? 'primary' : 'default'}
          disabled={isLocked}
          onClick={() => onUploadChange(false)}
        >
          电脑 → 手机
        </Button>
        <Button
          color={upload ? 'primary' : 'default'}
          disabled={isLocked}
          onClick={() => onUploadChange(true)}
        >
          手机 → 电脑
        </Button>
      </div>
      <div className="dual-directories">
        <DirectoryPane
          key={`local-${game.id}-${peerId}-${game.rootId ?? ''}-${String(upload)}`}
          adapter={adapter}
          deviceId={null}
          root={localRoot}
          title="本机手机"
          isSource={upload}
          isDisabled={isLocked}
          isOnline
          onLocation={onLocalLocation}
        />
        <DirectoryPane
          key={`remote-${game.id}-${peerId}-${remoteGame?.root?.rootId ?? ''}-${String(upload)}`}
          adapter={adapter}
          deviceId={peerId || null}
          root={remoteGame?.root ?? null}
          title={selectedPeer?.device.name ?? '对端设备'}
          isSource={!upload}
          isDisabled={isLocked}
          isOnline={Boolean(selectedPeer?.isConnected)}
          onLocation={onRemoteLocation}
        />
      </div>
      <Panel>
        <div className="rule-row">
          <div>
            删除目标端多出的文件<small>镜像删除将在后续版本开放</small>
          </div>
          <Switch checked={false} disabled aria-label="删除目标端多出的文件" />
        </div>
        <div className="rule-row">
          <div>
            覆盖前备份<small>覆盖复制与备份将在后续版本开放</small>
          </div>
          <Switch checked disabled aria-label="覆盖前备份" />
        </div>
      </Panel>
      <div className="notice">当前新建文件，同名文件请在预览中改名。</div>
      <div className="action-row equal">
        <Button disabled={isLocked} onClick={onOpenSettings}>
          目录设置
        </Button>
      </div>
    </>
  )
}
