import { useEffect, useState } from 'react'
import { ActionSheet, Button, Input } from 'antd-mobile'
import { EditOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons'
import type {
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  PosterAdapter,
  PosterImageCandidate,
} from '@savedata-sync/shared'
import {
  FolderRow,
  LinkedDeviceList,
  LinkPicker,
  linkedDevices,
  linkPickerDevices,
  linkPickerGames,
  PosterRow,
  useT,
} from '@savedata-sync/shared/ui'
import { Sheet } from '../../components/Sheet'
import { PosterSearchSheet } from './PosterSearchSheet'

/** 关联弹层的状态：link 先选设备再选游戏；relink 设备已定，只改对应的游戏。 */
interface LinkDraft {
  readonly mode: 'link' | 'relink'
  readonly deviceId: string | null
  readonly gameId: string | null
}

/** 游戏设置：名称就地编辑，本机目录和封面各一行，关联设备列表；关联、解除和搜索封面都在弹层里完成。 */
export function GameSettingsPage({
  game,
  peers,
  localRoot,
  posterUrl,
  coverIndex,
  posters,
  isDisabled,
  isActive,
  onRename,
  onChooseDirectory,
  onPickSearchedPoster,
  onPickPoster,
  onRemovePoster,
  onLink,
  onUnlink,
  onTransfer,
  onManageDevices,
  onOverlayChange,
}: {
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly localRoot: DirectoryReference | null
  /** 封面图地址；没有封面或还没读出时为 null。 */
  readonly posterUrl: string | null
  /** 占位封面的配色序号，和游戏卡片一致。 */
  readonly coverIndex: number
  /** 在线搜索封面用的适配器。 */
  readonly posters: PosterAdapter
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onRename: (value: string) => void
  readonly onChooseDirectory: () => void
  /** 下载并保存搜索选中的图片，成功后 resolve，搜索弹层随之关闭。 */
  readonly onPickSearchedPoster: (candidate: PosterImageCandidate) => Promise<void>
  readonly onPickPoster: () => void
  readonly onRemovePoster: () => void
  /** 关联或改为对应其他游戏，成功后 resolve。 */
  readonly onLink: (deviceId: string, gameId: string) => Promise<void>
  readonly onUnlink: (deviceId: string) => void
  readonly onTransfer: (deviceId: string) => void
  readonly onManageDevices: () => void
  /** 打开弹层时交给应用一个关闭函数，供返回键使用；关闭后传 null。 */
  readonly onOverlayChange: (close: (() => void) | null) => void
}): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState(game.name)
  // 只在已保存的名称变化后同步输入框；保存失败时保留输入草稿。
  const savedNameKey = `${game.id}
${game.name}`
  const [syncedNameKey, setSyncedNameKey] = useState(savedNameKey)
  if (syncedNameKey !== savedNameKey) {
    setSyncedNameKey(savedNameKey)
    setName(game.name)
  }
  const [draft, setDraft] = useState<LinkDraft | null>(null)
  const [menuDeviceId, setMenuDeviceId] = useState<string | null>(null)
  const [isLinking, setIsLinking] = useState(false)
  const [isPosterSearchOpen, setIsPosterSearchOpen] = useState(false)
  const [isPosterMenuOpen, setIsPosterMenuOpen] = useState(false)
  const [posterSavingId, setPosterSavingId] = useState<string | null>(null)
  const isOverlayOpen =
    draft !== null || menuDeviceId !== null || isPosterSearchOpen || isPosterMenuOpen
  useEffect(() => {
    if (!isOverlayOpen) {
      return
    }
    onOverlayChange(() => {
      setDraft(null)
      setMenuDeviceId(null)
      setIsPosterMenuOpen(false)
      // 保存中关不掉搜索弹层，和点遮罩、关闭按钮一样。
      setIsPosterSearchOpen((isOpen) => isOpen && posterSavingId !== null)
    })
    return () => onOverlayChange(null)
  }, [isOverlayOpen, onOverlayChange, posterSavingId])
  const isLocked = isDisabled || isActive
  const items = linkedDevices(game, peers, 'pc', t('game.deviceRemoved'))
  const menuItem = items.find((item) => item.deviceId === menuDeviceId)
  const draftPeer = peers.find((peer) => peer.device.id === draft?.deviceId)
  function openLink(): void {
    const available = linkPickerDevices(game, peers, 'pc').filter(
      (item) => item.state === 'available',
    )
    const only = available.length === 1 ? available[0] : undefined
    const recommended = only
      ? linkPickerGames(
          game,
          peers.find((peer) => peer.device.id === only.deviceId),
        )[0]
      : undefined
    setDraft({
      mode: 'link',
      deviceId: only?.deviceId ?? null,
      gameId: recommended?.isRecommended ? recommended.id : null,
    })
  }
  function selectDevice(deviceId: string): void {
    const recommended = linkPickerGames(
      game,
      peers.find((peer) => peer.device.id === deviceId),
    )[0]
    setDraft({
      mode: 'link',
      deviceId,
      gameId: recommended?.isRecommended ? recommended.id : null,
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
  function pickSearchedPoster(candidate: PosterImageCandidate): void {
    if (posterSavingId !== null) {
      return
    }
    setPosterSavingId(candidate.id)
    onPickSearchedPoster(candidate)
      .then(() => setIsPosterSearchOpen(false))
      // 失败已由应用提示，弹层留着让用户换一张。
      .catch(() => undefined)
      .finally(() => setPosterSavingId(null))
  }
  return (
    <div className="page-stack">
      <label className="name-edit">
        <Input
          aria-label={t('game.name')}
          value={name}
          maxLength={128}
          disabled={isDisabled}
          onChange={setName}
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
      <section>
        <h3 className="group-title">{t('poster.section')}</h3>
        <PosterRow
          hasPoster={Boolean(game.posterHash)}
          posterSource={game.posterSource ?? null}
          posterUrl={posterUrl}
          coverIndex={coverIndex}
          actions={null}
          menu={
            <Button
              fill="none"
              aria-label={t('poster.menu')}
              disabled={isDisabled}
              onClick={() => setIsPosterMenuOpen(true)}
            >
              <MoreOutlined />
            </Button>
          }
        />
      </section>
      <section>
        <h3 className="group-title">
          {t('game.linkedDevices')}
          <Button fill="none" size="small" color="primary" disabled={isLocked} onClick={openLink}>
            <PlusOutlined /> {t('game.link')}
          </Button>
        </h3>
        <LinkedDeviceList
          items={items}
          actions={(item) => (
            <Button
              fill="none"
              aria-label={t('game.deviceMenu')}
              onClick={() => setMenuDeviceId(item.deviceId)}
            >
              <MoreOutlined />
            </Button>
          )}
        />
      </section>
      <Sheet
        isOpen={draft !== null}
        title={
          draft?.mode === 'relink' && draftPeer
            ? t('game.relinkTitle', { name: draftPeer.device.name })
            : t('game.linkTitle')
        }
        isBusy={isLinking}
        onClose={() => setDraft(null)}
      >
        {draft ? (
          <div className="page-stack">
            {draft.mode === 'link' && <p className="muted">{t('game.linkHint')}</p>}
            <LinkPicker
              devices={linkPickerDevices(game, peers, 'pc')}
              isDeviceStepShown={draft.mode === 'link'}
              selectedDevice={
                draftPeer ? { deviceId: draftPeer.device.id, name: draftPeer.device.name } : null
              }
              games={linkPickerGames(game, draftPeer)}
              selectedGameId={draft.gameId}
              onSelectDevice={selectDevice}
              onSelectGame={(gameId) => setDraft({ ...draft, gameId })}
              onConnect={() => {
                setDraft(null)
                onManageDevices()
              }}
            />
            <Button
              block
              color="primary"
              loading={isLinking}
              disabled={isLocked || !draft.deviceId || !draft.gameId}
              onClick={confirmLink}
            >
              {t('game.link')}
            </Button>
          </div>
        ) : null}
      </Sheet>
      <ActionSheet
        visible={menuItem !== undefined}
        extra={
          menuItem ? (
            <div className="sheet-caption">
              <b>{menuItem.name}</b>
              <span>
                {menuItem.isConnected ? t('transfer.connected') : t('transfer.disconnected')}
                {menuItem.gameName ? ` · ${menuItem.gameName}` : null}
              </span>
            </div>
          ) : null
        }
        cancelText={t('common.cancel')}
        actions={[
          {
            key: 'transfer',
            text: t('game.transfer'),
            disabled: isActive || !menuItem?.isConnected || !localRoot,
          },
          {
            key: 'relink',
            text: t('game.relink'),
            disabled: isLocked || !menuItem?.isConnected,
          },
          {
            key: 'unlink',
            text: t('game.unlink'),
            danger: true,
            disabled: isLocked,
          },
        ]}
        onAction={(action) => {
          const deviceId = menuDeviceId
          setMenuDeviceId(null)
          if (!deviceId) {
            return
          }
          if (action.key === 'transfer') {
            onTransfer(deviceId)
          } else if (action.key === 'relink') {
            const current = game.links.find((link) => link.deviceId === deviceId)
            setDraft({ mode: 'relink', deviceId, gameId: current?.gameId ?? null })
          } else {
            onUnlink(deviceId)
          }
        }}
        onClose={() => setMenuDeviceId(null)}
      />
      <PosterSearchSheet
        isOpen={isPosterSearchOpen}
        gameName={game.name}
        adapter={posters}
        savingId={posterSavingId}
        onPick={pickSearchedPoster}
        onClose={() => setIsPosterSearchOpen(false)}
      />
      <ActionSheet
        visible={isPosterMenuOpen}
        cancelText={t('common.cancel')}
        actions={[
          { key: 'search', text: t('poster.search'), disabled: isDisabled },
          { key: 'local', text: t('poster.local'), disabled: isDisabled },
          ...(game.posterHash
            ? [{ key: 'remove', text: t('poster.remove'), danger: true, disabled: isDisabled }]
            : []),
        ]}
        onAction={(action) => {
          setIsPosterMenuOpen(false)
          if (action.key === 'search') {
            setIsPosterSearchOpen(true)
          } else if (action.key === 'local') {
            onPickPoster()
          } else {
            onRemovePoster()
          }
        }}
        onClose={() => setIsPosterMenuOpen(false)}
      />
    </div>
  )
}
