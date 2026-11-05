import { useEffect, useState } from 'react'
import { Button, Dropdown, Input, Modal } from 'antd'
import { EditOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons'
import type { DirectoryReference, LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import {
  FolderRow,
  LinkedDeviceList,
  LinkPicker,
  linkedDevices,
  linkPickerDevices,
  linkPickerGames,
  useT,
} from '@savedata-sync/shared/ui'

/** 关联对话框的状态：link 先选设备再选游戏；relink 设备已定，只改对应的游戏。 */
interface LinkDraft {
  readonly mode: 'link' | 'relink'
  readonly deviceId: string | null
  readonly gameId: string | null
}

/** 默认选中同名游戏。 */
function recommendedGame(game: LibraryGame, peer: LibraryPeer | undefined): string | null {
  const first = linkPickerGames(game, peer)[0]
  return first?.isRecommended ? first.id : null
}

/** 游戏设置：左栏名称与本机目录，右栏关联设备；备份设置只在“备份与恢复”。 */
export function GameSettingsPage({
  game,
  peers,
  localRoot,
  isDisabled,
  isActive,
  onRename,
  onChooseDirectory,
  onLink,
  onUnlink,
  onTransfer,
  onManageDevices,
}: {
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly localRoot: DirectoryReference | null
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onRename: (value: string) => void
  readonly onChooseDirectory: () => void
  /** 关联或改为对应其他游戏，成功后 resolve。 */
  readonly onLink: (deviceId: string, gameId: string) => Promise<void>
  readonly onUnlink: (deviceId: string) => void
  readonly onTransfer: (deviceId: string) => void
  readonly onManageDevices: () => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(game.name)
  const [draft, setDraft] = useState<LinkDraft | null>(null)
  const [isLinking, setIsLinking] = useState(false)
  // 只在已保存名称变化后同步；保存失败时保留输入草稿。
  useEffect(() => setName(game.name), [game.id, game.name])
  const isLocked = isDisabled || isActive
  const draftPeer = peers.find((peer) => peer.device.id === draft?.deviceId)
  function openLink(): void {
    const available = linkPickerDevices(game, peers, 'mobile').filter(
      (item) => item.state === 'available',
    )
    const only = available.length === 1 ? available[0] : undefined
    const peer = peers.find((item) => item.device.id === only?.deviceId)
    setDraft({
      mode: 'link',
      deviceId: only?.deviceId ?? null,
      gameId: only ? recommendedGame(game, peer) : null,
    })
  }
  function confirmLink(): void {
    if (!draft?.deviceId || !draft.gameId || isLinking) {
      return
    }
    setIsLinking(true)
    onLink(draft.deviceId, draft.gameId)
      .then(() => setDraft(null))
      .catch(() => undefined)
      .finally(() => setIsLinking(false))
  }
  return (
    <div className="settings-columns">
      <div className="library-stack">
        <label className="name-edit">
          <Input
            variant="borderless"
            aria-label={t('game.name')}
            value={name}
            maxLength={128}
            disabled={isDisabled}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => onRename(name)}
          />
          <EditOutlined />
        </label>
        <section>
          <h3 className="group-title">{t('game.localFolder')}</h3>
          <FolderRow
            name={localRoot?.displayName ?? null}
            path={localRoot?.displayPath ?? null}
            isLost={localRoot !== null && localRoot.authorization !== 'granted'}
            onChange={isLocked ? null : onChooseDirectory}
          />
        </section>
      </div>
      <section>
        <h3 className="group-title">
          {t('game.linkedDevices')}
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            disabled={isLocked}
            onClick={openLink}
          >
            {t('game.link')}
          </Button>
        </h3>
        <LinkedDeviceList
          items={linkedDevices(game, peers, 'mobile', t('game.deviceRemoved'))}
          actions={(item) => (
            <>
              {item.isConnected && (
                <Button
                  size="small"
                  disabled={isActive || !localRoot}
                  onClick={() => onTransfer(item.deviceId)}
                >
                  {t('game.transfer')}
                </Button>
              )}
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{
                  items: [
                    {
                      key: 'relink',
                      label: t('game.relink'),
                      disabled: isLocked || !item.isConnected,
                    },
                    { type: 'divider' },
                    {
                      key: 'unlink',
                      label: (
                        <span className="menu-label">
                          {t('game.unlink')}
                          <small>{t('game.unlinkHint')}</small>
                        </span>
                      ),
                      danger: true,
                      disabled: isLocked,
                    },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'relink') {
                      const current = game.links.find((link) => link.deviceId === item.deviceId)
                      setDraft({
                        mode: 'relink',
                        deviceId: item.deviceId,
                        gameId: current?.gameId ?? null,
                      })
                    } else {
                      onUnlink(item.deviceId)
                    }
                  },
                }}
              >
                <Button type="text" aria-label={t('game.deviceMenu')} icon={<MoreOutlined />} />
              </Dropdown>
            </>
          )}
        />
      </section>
      <Modal
        open={draft !== null}
        title={
          draft?.mode === 'relink' && draftPeer
            ? t('game.relinkTitle', { name: draftPeer.device.name })
            : t('game.linkTitle')
        }
        okText={t('game.link')}
        cancelText={t('common.cancel')}
        confirmLoading={isLinking}
        okButtonProps={{ disabled: isLocked || !draft?.deviceId || !draft.gameId }}
        mask={{ closable: !isLinking }}
        destroyOnHidden
        onOk={confirmLink}
        onCancel={() => setDraft(null)}
      >
        {draft && (
          <LinkPicker
            devices={linkPickerDevices(game, peers, 'mobile')}
            isDeviceStepShown={draft.mode === 'link'}
            selectedDevice={
              draftPeer ? { deviceId: draftPeer.device.id, name: draftPeer.device.name } : null
            }
            games={linkPickerGames(game, draftPeer)}
            selectedGameId={draft.gameId}
            onSelectDevice={(deviceId) =>
              setDraft({
                mode: 'link',
                deviceId,
                gameId: recommendedGame(
                  game,
                  peers.find((peer) => peer.device.id === deviceId),
                ),
              })
            }
            onSelectGame={(gameId) => setDraft({ ...draft, gameId })}
            onConnect={() => {
              setDraft(null)
              onManageDevices()
            }}
          />
        )}
      </Modal>
    </div>
  )
}
