import { Button, Card, Segmented, Select, Space, Switch, Tooltip } from 'antd'
import type {
  CatalogGame,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { Confirmation } from '../../app/navigation.ts'
import type { DesktopLibraryAdapter } from '../../platform/library-types.ts'
import { DirectoryPane } from './DirectoryPane.tsx'
import { RemoteSyncPanel } from './RemoteSyncPanel.tsx'

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
  onConfirm,
  onOpenTasks,
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
  readonly onConfirm: (confirmation: Confirmation) => void
  readonly onOpenTasks: () => void
}): React.JSX.Element {
  const isLocalSource = !upload
  const localLabel = `本机电脑 · ${localRoot?.displayPath ?? localRoot?.displayName ?? '未选择目录'}`
  const remoteLabel = `${selectedPeer?.device.name ?? '手机'} · ${remoteGame?.root?.displayPath ?? remoteGame?.root?.displayName ?? '未选择目录'}`
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
      </Card>
      {selectedPeer && remoteGame && (
        <RemoteSyncPanel
          projectId={game.id}
          gameName={game.name}
          peerId={peerId}
          direction={upload ? 'android-to-windows' : 'windows-to-android'}
          isOnline={selectedPeer.isConnected}
          isDisabled={isDisabled || isActive}
          sourceLabel={isLocalSource ? localLabel : remoteLabel}
          targetLabel={isLocalSource ? remoteLabel : localLabel}
          onConfirm={onConfirm}
          onOpenTasks={onOpenTasks}
        />
      )}
      <Space wrap>
        <Button disabled={isDisabled || isActive} onClick={onOpenSettings}>
          目录设置
        </Button>
      </Space>
    </>
  )
}
