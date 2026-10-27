import { useEffect, useState } from 'react'
import { Button, Input } from 'antd-mobile'
import { FolderOpenOutlined } from '@ant-design/icons'
import type { DirectoryReference, LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { Panel } from '../../components/Panel'
import { ChoiceField } from '../../components/ChoiceField'
import { EmptyState } from '../../components/EmptyState'

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
  const [name, setName] = useState(game.name)
  // 只在已保存名称变化后同步；保存失败时保留输入草稿。
  useEffect(() => setName(game.name), [game.id, game.name])
  const isLocked = isDisabled || isActive
  return (
    <>
      <Panel>
        <label className="field">
          游戏名称
          <Input
            value={name}
            maxLength={128}
            disabled={isDisabled}
            onChange={setName}
            onBlur={() => onRename(name)}
          />
        </label>
      </Panel>
      <Panel title="本机手机目录">
        <p className="directory-name">
          {localRoot?.displayPath ?? localRoot?.displayName ?? '未选择目录'}
        </p>
        <Button block disabled={isLocked} onClick={onChooseDirectory}>
          <FolderOpenOutlined /> 选择目录
        </Button>
      </Panel>
      <Panel title="已关联设备">
        {game.links.length ? (
          game.links.map((link) => {
            const peer = peers.find((item) => item.device.id === link.deviceId)
            const remote = peer?.games.find((item) => item.id === link.gameId)
            return (
              <div className="linked-device" key={link.deviceId}>
                <strong>{peer?.device.name ?? '设备已移除'}</strong>
                <p>
                  {remote?.root?.displayPath ??
                    remote?.root?.displayName ??
                    (peer?.isConnected ? '此设备尚未设置目录' : '连接后读取目录')}
                </p>
                <Button disabled={isLocked} onClick={() => onUnlink(link.deviceId)}>
                  解除关联
                </Button>
              </div>
            )
          })
        ) : (
          <EmptyState description="尚未关联设备" />
        )}
        <div className="page-stack">
          <ChoiceField
            label="选择设备"
            value={linkPeerId}
            isDisabled={isLocked}
            options={peers
              .filter((peer) => !game.links.some((link) => link.deviceId === peer.device.id))
              .map((peer) => ({
                value: peer.device.id,
                label: peer.device.name,
                isDisabled: !peer.isConnected,
              }))}
            onChange={onLinkPeerChange}
          />
          <ChoiceField
            label="选择这台设备上的游戏"
            value={linkGameId}
            isDisabled={isLocked || !linkPeerId}
            options={
              peers
                .find((peer) => peer.device.id === linkPeerId)
                ?.games.map((item) => ({ value: item.id, label: item.name })) ?? []
            }
            onChange={onLinkGameChange}
          />
          <Button block disabled={isLocked || !linkPeerId || !linkGameId} onClick={onLink}>
            关联
          </Button>
        </div>
      </Panel>
      <Button block onClick={onManageDevices}>
        管理设备
      </Button>
    </>
  )
}
