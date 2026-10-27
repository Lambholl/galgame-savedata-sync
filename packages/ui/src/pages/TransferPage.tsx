import { Alert, Button, Card, Input, Segmented, Select, Space, Switch, Tooltip } from 'antd'
import type {
  CatalogGame,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { UiAdapter } from '../api.ts'
import { DirectoryPane } from '../DirectoryPane.tsx'
import type { PaneLocation } from '../DirectoryPane.tsx'
import type { Page } from '../library-types.ts'

export function TransferPage({
  adapter,
  page,
  game,
  peers,
  selectedPeer,
  remoteGame,
  localRoot,
  peerId,
  upload,
  targetNames,
  source,
  isMobile,
  isDisabled,
  isActive,
  previewMessage,
  onPeerChange,
  onUploadChange,
  onLocalLocation,
  onRemoteLocation,
  onChooseReceive,
  onOpenSettings,
  onTargetNameChange,
}: {
  readonly adapter: UiAdapter
  readonly page: Page
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly selectedPeer: LibraryPeer | null
  readonly remoteGame: CatalogGame | undefined
  readonly localRoot: DirectoryReference | null
  readonly peerId: string
  readonly upload: boolean
  readonly targetNames: Readonly<Record<string, string>>
  readonly source: PaneLocation | null
  readonly isMobile: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly previewMessage: string
  readonly onPeerChange: (id: string) => void
  readonly onUploadChange: (isUpload: boolean) => void
  readonly onLocalLocation: (value: PaneLocation | null) => void
  readonly onRemoteLocation: (value: PaneLocation | null) => void
  readonly onChooseReceive: () => void
  readonly onOpenSettings: () => void
  readonly onTargetNameChange: (entryId: string, value: string) => void
}): React.JSX.Element {
  const isLocalSource = isMobile ? upload : !upload
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
          key={`local-${game.id}-${game.rootId ?? ''}-${String(upload)}`}
          adapter={adapter}
          deviceId={null}
          root={localRoot}
          title={`本机${isMobile ? '手机' : '电脑'}`}
          isSource={isLocalSource}
          isDisabled={isDisabled || isActive}
          isOnline
          onLocation={onLocalLocation}
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
          onLocation={onRemoteLocation}
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
      <Alert type="info" showIcon title="当前新建文件，同名文件请在预览中改名。" />
      {!isMobile && <Alert type="info" title="在手机发起传输，电脑显示任务与接收结果。" showIcon />}
      <Space wrap>
        <Button disabled={isDisabled || isActive} onClick={onOpenSettings}>
          目录设置
        </Button>
        {isMobile && (
          <Button disabled={isDisabled || isActive} onClick={onChooseReceive}>
            允许手机接收
          </Button>
        )}
      </Space>
      {page === 'preview' && (
        <Card title={`新建 ${source?.files.length ?? 0} 个文件`}>
          {source?.files.map((file) => (
            <label className="library-field" key={file.entryId}>
              {file.name}
              <Input
                aria-label={`${file.name} 的目标名称`}
                value={targetNames[file.entryId] ?? file.name}
                onChange={(event) => onTargetNameChange(file.entryId, event.target.value)}
              />
            </label>
          ))}
          {previewMessage && <Alert type="warning" title={previewMessage} showIcon />}
        </Card>
      )}
    </>
  )
}
