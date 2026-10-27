import { Alert, Button, Card, Segmented, Select, Space, Switch, Tooltip } from 'antd'
import type {
  CatalogGame,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { DesktopLibraryAdapter } from '../../platform/library-types.ts'
import { DirectoryPane } from './DirectoryPane.tsx'

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
  onOpenSettings,
}: {
  readonly adapter: DesktopLibraryAdapter
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
  readonly onOpenSettings: () => void
}): React.JSX.Element {
  const isLocalSource = !upload
  return (
    <>
      <label className="library-field">
        对端设备
        <Select
          aria-label="对端设备"
          value={selectedPeer ? peerId : null}
          className="library-full"
          placeholder="选择本次对端"
          disabled={isDisabled || isActive}
          options={game.links.map((link) => {
            const peer = peers.find((item) => item.device.id === link.deviceId)
            return {
              value: link.deviceId,
              label: `${peer?.device.name ?? '未知设备'} · ${peer?.isConnected ? '已连接' : '未连接'}`,
            }
          })}
          onChange={onPeerChange}
        />
      </label>
      <div className="library-dual">
        <DirectoryPane
          key={`local-${game.id}-${peerId}-${game.rootId ?? ''}-${String(upload)}`}
          adapter={adapter}
          deviceId={null}
          root={localRoot}
          title="本机电脑"
          isSource={isLocalSource}
          isDisabled={isDisabled || isActive}
          isOnline
        />
        <DirectoryPane
          key={`remote-${game.id}-${peerId}-${remoteGame?.root?.rootId ?? ''}-${String(upload)}`}
          adapter={adapter}
          deviceId={peerId || null}
          root={remoteGame?.root ?? null}
          title={selectedPeer?.device.name ?? '对端设备'}
          isSource={!isLocalSource}
          isDisabled={isDisabled || isActive}
          isOnline={Boolean(selectedPeer?.isConnected)}
        />
      </div>
      <Segmented
        block
        disabled={isDisabled || isActive}
        value={upload ? 'upload' : 'download'}
        options={[
          { label: '电脑 → 手机', value: 'download' },
          { label: '手机 → 电脑', value: 'upload' },
        ]}
        onChange={(value) => onUploadChange(value === 'upload')}
      />
      <Card size="small" className="library-rules">
        <div>
          <span>删除目标端多出的文件</span>
          <Tooltip title="镜像删除将在后续版本开放">
            <Switch checked={false} disabled size="small" aria-label="删除目标端多出的文件" />
          </Tooltip>
        </div>
        <div>
          <span>覆盖前备份</span>
          <Tooltip title="覆盖复制与备份将在后续版本开放">
            <Switch checked disabled size="small" aria-label="覆盖前备份" />
          </Tooltip>
        </div>
      </Card>
      <Alert type="info" showIcon title="当前新建文件，同名文件请在手机预览中改名。" />
      <Alert type="info" title="在手机发起传输，电脑显示任务与接收结果。" showIcon />
      <Space wrap>
        <Button disabled={isDisabled || isActive} onClick={onOpenSettings}>
          目录设置
        </Button>
      </Space>
    </>
  )
}
