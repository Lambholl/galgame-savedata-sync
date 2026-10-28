import { Button, Card, Empty, Input, Select, Space } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import type { DirectoryReference, LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { BackupPreference } from '../backup/BackupPreference.tsx'

export function GameSettingsPage({
  game,
  peers,
  localRoot,
  linkPeerId,
  linkGameId,
  isDisabled,
  isActive,
  onRename,
  onChooseDirectory,
  onUnlink,
  onLinkPeerChange,
  onLinkGameChange,
  onLink,
  onManageDevices,
}: {
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly localRoot: DirectoryReference | null
  readonly linkPeerId: string
  readonly linkGameId: string
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onRename: (value: string) => void
  readonly onChooseDirectory: () => void
  readonly onUnlink: (deviceId: string) => void
  readonly onLinkPeerChange: (id: string) => void
  readonly onLinkGameChange: (id: string) => void
  readonly onLink: () => void
  readonly onManageDevices: () => void
}): React.JSX.Element {
  return (
    <>
      <Card>
        <label className="library-field">
          游戏名称
          <Input
            key={game.id}
            defaultValue={game.name}
            maxLength={128}
            onBlur={(event) => onRename(event.target.value)}
          />
        </label>
      </Card>
      <Card title="本机电脑目录">
        <div className="library-directory-setting">
          <p className="library-directory-path" aria-label="本机存档目录">
            {localRoot?.displayPath ?? localRoot?.displayName ?? '未选择目录'}
          </p>
          <Button
            icon={<FolderOpenOutlined />}
            aria-label="选择目录"
            disabled={isDisabled || isActive}
            onClick={onChooseDirectory}
          />
        </div>
      </Card>
      {game.rootId && (
        <Card title="本机备份保护">
          <BackupPreference
            key={`${game.id}/${game.rootId}`}
            projectId={game.id}
            rootId={game.rootId}
            rootLabel={localRoot?.displayPath ?? localRoot?.displayName ?? game.name}
            isDisabled={isDisabled || isActive}
          />
        </Card>
      )}
      <Card title="已关联设备">
        {game.links.map((link) => {
          const peer = peers.find((item) => item.device.id === link.deviceId)
          const remote = peer?.games.find((item) => item.id === link.gameId)
          return (
            <div className="library-linked-row" key={link.deviceId}>
              <div>
                <strong>{peer?.device.name ?? '设备已移除'}</strong>
                <p>
                  {remote?.root?.displayPath ??
                    remote?.root?.displayName ??
                    (peer?.isConnected ? '此设备尚未设置目录' : '连接后读取目录')}
                </p>
              </div>
              <Button disabled={isDisabled || isActive} onClick={() => onUnlink(link.deviceId)}>
                解除关联
              </Button>
            </div>
          )
        })}
        {!game.links.length && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未关联设备" />
        )}
        <Space orientation="vertical" className="library-full">
          <Select
            aria-label="关联设备"
            className="library-full"
            placeholder="选择设备"
            value={linkPeerId || null}
            options={peers
              .filter((peer) => !game.links.some((link) => link.deviceId === peer.device.id))
              .map((peer) => ({
                value: peer.device.id,
                label: peer.device.name,
                disabled: !peer.isConnected,
              }))}
            onChange={onLinkPeerChange}
          />
          <Select
            aria-label="对应游戏"
            className="library-full"
            placeholder="选择这台设备上的游戏"
            value={linkGameId || null}
            options={
              peers
                .find((item) => item.device.id === linkPeerId)
                ?.games.map((item) => ({ value: item.id, label: item.name })) ?? []
            }
            onChange={onLinkGameChange}
          />
          <Button disabled={isDisabled || !linkPeerId || !linkGameId || isActive} onClick={onLink}>
            关联
          </Button>
        </Space>
      </Card>
      <Button onClick={onManageDevices}>管理设备</Button>
    </>
  )
}
