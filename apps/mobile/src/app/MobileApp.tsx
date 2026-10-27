import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Toast } from 'antd-mobile'
import { EmptyState } from '../components/EmptyState'
import {
  emptyLibrary,
  taskIsActive,
  validateTransferSelection,
  withGameLink,
  withoutGameLink,
  createImportedGame,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter, MobileSnapshot } from '../platform/library-types'
import type { DirectoryLocation } from '@savedata-sync/shared'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { DeviceEditorDialog } from '../components/DeviceEditorDialog.tsx'
import { GameActions } from '../features/games/GameActions'
import { GameMenu } from '../features/games/GameActionSheet'
import { ImportGameDialog } from '../components/ImportGameDialog.tsx'
import { LibraryShell } from '../components/LibraryShell.tsx'
import { PAGE_TITLES } from './navigation-types'
import type { BackButtonController, Confirmation, Page } from './navigation-types'
import { BackupPage } from '../features/backup/BackupPage'
import { DevicesPage } from '../features/devices/DevicesPage'
import { GamesPage } from '../features/games/GamesPage'
import { GameSettingsPage } from '../features/games/GameSettingsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { TaskPage } from '../features/transfer/TaskPage'
import { TransferPage } from '../features/transfer/TransferPage'
import { TransferPreviewPage } from '../features/transfer/TransferPreviewPage'
import '../styles/mobile.css'

import { AddGameDialog } from '../features/games/AddGameDialog'

const EMPTY = emptyLibrary()

/** 移动应用状态与返回栈；传输由原生持有，页面切换保留任务。 */
export function MobileApp({
  adapter,
  backButton,
}: {
  readonly adapter: MobileLibraryAdapter
  readonly backButton?: BackButtonController
}): React.JSX.Element {
  const [page, setPage] = useState<Page>('games')
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [gameId, setGameId] = useState('')
  const [peerId, setPeerId] = useState('')
  const [isGameMenuOpen, setIsGameMenuOpen] = useState(false)
  const [isDeviceEditorOpen, setIsDeviceEditorOpen] = useState(false)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [deviceAddress, setDeviceAddress] = useState('')
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isAddGameOpen, setIsAddGameOpen] = useState(false)
  const [newDirectory, setNewDirectory] = useState<DirectoryReference | null>(null)
  const [newGameName, setNewGameName] = useState('')
  const [importedGame, setImportedGame] = useState<{ deviceId: string; game: CatalogGame } | null>(
    null,
  )
  const [importKey, setImportKey] = useState('')
  const [linkPeerId, setLinkPeerId] = useState('')
  const [linkGameId, setLinkGameId] = useState('')
  const [upload, setUpload] = useState(false)
  const [localLocation, setLocalLocation] = useState<DirectoryLocation | null>(null)
  const [remoteLocation, setRemoteLocation] = useState<DirectoryLocation | null>(null)
  const [targetNames, setTargetNames] = useState<Readonly<Record<string, string>>>({})
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++generation.current
    const value = await adapter.read()
    if (version === generation.current) {
      snapshotRef.current = value
      setSnapshot(value)
      if (value.warning) {
        setError(value.warning)
      }
    }
  }, [adapter])
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      if (!isCurrent) {
        return
      }
      if (!operating.current && document.visibilityState !== 'hidden') {
        try {
          await refresh()
        } catch (cause) {
          if (isCurrent) {
            setError(cause instanceof Error ? cause.message : '读取应用状态失败。')
          }
        }
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch(() => setError('刷新失败，请重试。'))
        }, 1800)
      }
    }
    poll().catch(() => setError('读取应用失败。'))
    return () => {
      isCurrent = false
      invalidate()
      clearTimeout(timer)
    }
  }, [refresh, invalidate])
  useEffect(() => backButton?.subscribe(() => backHandler.current()), [backButton])
  function run(work: () => Promise<void>, onError?: (message: string) => void): void {
    if (operating.current) {
      return
    }
    operating.current = true
    generation.current++
    setIsBusy(true)
    setError('')
    work()
      .then(refresh)
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : '操作失败，请重试。'
        if (onError) {
          onError(message)
        } else {
          setError(message)
        }
      })
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  const config = snapshot?.config ?? EMPTY
  const game = config.games.find((item) => item.id === gameId) ?? null
  const peers = snapshot?.peers ?? []
  const online = peers.find((item) => item.isConnected) ?? null
  const selectedPeer =
    peers.find(
      (item) => item.device.id === peerId && game?.links.some((link) => link.deviceId === peerId),
    ) ?? null
  const remoteGame = selectedPeer?.games.find(
    (item) => item.id === game?.links.find((link) => link.deviceId === peerId)?.gameId,
  )
  const localRoot = snapshot?.roots.find((item) => item.rootId === game?.rootId) ?? null
  const isActive = snapshot?.tasks.some(taskIsActive) ?? false
  const isDisabled = isBusy || !snapshot
  const isLocalSource = upload
  const source = isLocalSource ? localLocation : remoteLocation
  const target = isLocalSource ? remoteLocation : localLocation
  const importable = peers
    .filter((item) => item.isConnected)
    .flatMap((peer) =>
      peer.games
        .filter(
          (item) =>
            !config.games.some((value) =>
              value.links.some(
                (link) => link.deviceId === peer.device.id && link.gameId === item.id,
              ),
            ),
        )
        .map((item) => ({ key: `${peer.device.id}/${item.id}`, peer, item })),
    )
  function openGame(item: LibraryGame): void {
    setGameId(item.id)
    setPeerId(item.links.length === 1 ? (item.links[0]?.deviceId ?? '') : '')
    setIsGameMenuOpen(true)
    setLocalLocation(null)
    setRemoteLocation(null)
    setTargetNames({})
  }
  async function saveGame(item: LibraryGame): Promise<void> {
    const current = snapshotRef.current?.config
    if (!current) {
      throw new Error('配置还没有读取完成。')
    }
    await adapter.saveGames(current.games.map((value) => (value.id === item.id ? item : value)))
  }
  function renameGame(value: string): void {
    if (!game) {
      return
    }
    const name = value.trim()
    if (!name) {
      setError('游戏名称不能为空。')
      return
    }
    if (name !== game.name) {
      run(() => saveGame({ ...game, name }))
    }
  }
  function chooseDirectory(): void {
    if (!game) {
      return
    }
    run(async () => {
      const result = await adapter.chooseDirectory()
      if (result.status === 'error') {
        throw new Error(result.error.message)
      }
      if (result.status === 'selected') {
        await saveGame({ ...game, rootId: result.directory.rootId })
      }
    })
  }
  function addGame(): void {
    setNewDirectory(null)
    setNewGameName('')
    setImportedGame(null)
    setError('')
    setIsAddGameOpen(true)
  }
  function closeAddGame(): void {
    if (isBusy) {
      return
    }
    setIsAddGameOpen(false)
    setNewDirectory(null)
    setNewGameName('')
    setImportedGame(null)
    setError('')
  }
  function chooseNewDirectory(): void {
    run(async () => {
      const result = await adapter.chooseDirectory()
      if (result.status === 'error') {
        throw new Error(result.error.message)
      }
      if (result.status === 'selected') {
        setNewDirectory(result.directory)
        setNewGameName(
          (result.directory.parentName ?? result.directory.displayName).trim().slice(0, 128),
        )
      }
    })
  }
  function confirmAddGame(): void {
    if (!newDirectory || !newGameName.trim()) {
      return
    }
    const directory = newDirectory
    const name = newGameName.trim()
    const imported = importedGame
    run(async () => {
      const current = snapshotRef.current?.config
      if (!current) {
        throw new Error('配置还没有读取完成。')
      }
      const item: LibraryGame = imported
        ? {
            ...createImportedGame(crypto.randomUUID(), imported.game, imported.deviceId),
            name,
            rootId: directory.rootId,
          }
        : {
            id: crypto.randomUUID(),
            name,
            rootId: directory.rootId,
            links: [],
          }
      await adapter.saveGames([...current.games, item])
      setGameId(item.id)
      setPeerId(imported?.deviceId ?? '')
      setIsAddGameOpen(false)
      setNewDirectory(null)
      setNewGameName('')
      setImportedGame(null)
      setPage('games')
    })
  }
  function deviceEditor(id: string | null): void {
    const item = config.devices.find((value) => value.id === id)
    setEditingDeviceId(id)
    setDeviceName(item?.name ?? '')
    setDeviceAddress(item?.address ?? '')
    setIsDeviceEditorOpen(true)
  }
  function saveDevice(): void {
    run(
      async () => {
        if (editingDeviceId) {
          await adapter.device(editingDeviceId, 'rename', deviceName.trim(), deviceAddress)
        } else {
          await adapter.connect(deviceAddress)
        }
        setIsDeviceEditorOpen(false)
      },
      editingDeviceId ? undefined : showConnectionFailure,
    )
  }
  function removeDevice(): void {
    if (!editingDeviceId) {
      return
    }
    const deviceId = editingDeviceId
    setConfirmation({
      title: '移除设备',
      text: '移除设备和相关游戏关联，保留存档文件。',
      okType: 'danger',
      work: async () => {
        await adapter.device(deviceId, 'forget')
        setIsDeviceEditorOpen(false)
        setConfirmation(null)
      },
    })
  }
  function copyAddress(address: string): void {
    run(async () => {
      await navigator.clipboard.writeText(address)
      setCopied(address)
    })
  }
  function actOnDevice(peer: LibraryPeer): void {
    run(
      () => adapter.device(peer.device.id, peer.isConnected ? 'disconnect' : 'allow'),
      peer.isConnected ? undefined : showConnectionFailure,
    )
  }
  function showConnectionFailure(message: string): void {
    Toast.show({
      content: `连接失败：${message}`,
      duration: 3500,
      position: 'top',
      maskClickable: true,
      maskStyle: { zIndex: 1400 },
    })
  }
  function go(value: Page): void {
    setIsGameMenuOpen(false)
    setPage(value)
  }
  function goBack(): void {
    setPage(page === 'preview' ? 'transfer' : 'games')
  }
  function changePeer(id: string): void {
    setPeerId(id)
    setLocalLocation(null)
    setRemoteLocation(null)
    setTargetNames({})
    setPage('transfer')
  }
  function changeUpload(isUpload: boolean): void {
    setUpload(isUpload)
    setTargetNames({})
    setPage('transfer')
  }
  function changeLinkPeer(id: string): void {
    setLinkPeerId(id)
    setLinkGameId('')
  }
  function unlinkGame(deviceId: string): void {
    if (!game) {
      return
    }
    run(() => saveGame(withoutGameLink(game, deviceId)))
  }
  function linkGame(): void {
    if (!game || !linkPeerId || !linkGameId) {
      return
    }
    run(async () => {
      await saveGame(withGameLink(game, linkPeerId, linkGameId))
      setPeerId(linkPeerId)
      setLinkPeerId('')
      setLinkGameId('')
    })
  }
  function importGame(): void {
    const choice = importable.find((item) => item.key === importKey)
    if (!choice) {
      return
    }
    setImportedGame({ deviceId: choice.peer.device.id, game: choice.item })
    setNewDirectory(null)
    setNewGameName('')
    setError('')
    setIsImportOpen(false)
    setIsAddGameOpen(true)
  }
  function removeGame(): void {
    setIsGameMenuOpen(false)
    setConfirmation({
      title: '移除游戏',
      text: '移除游戏配置和设备关联，保留存档文件。',
      work: async () => {
        await adapter.saveGames(config.games.filter((item) => item.id !== gameId))
        setConfirmation(null)
        setPage('games')
      },
    })
  }
  function previewError(): string {
    const problem = validateTransferSelection({
      isPeerConnected: Boolean(selectedPeer?.isConnected),
      source,
      target,
      names: targetNames,
      isReceiveAuthorized: true,
    })
    if (!problem) {
      return ''
    }
    return {
      'peer-disconnected': '请连接这个游戏关联的设备。',
      'directories-missing': '请读取两端目录。',
      'files-empty': '请选择当前层要传输的文件。',
      'invalid-name': '请填写有效的单个目标文件名。',
      'duplicate-names': '本批次有重复的目标文件名。',
      'target-exists': '目标有同名条目，请修改目标名称。',
      'receive-not-authorized': '存档目录权限已失效，请到目录设置重新选择。',
    }[problem]
  }

  function start(): void {
    if (!game || !source || !target || !selectedPeer) {
      return
    }
    const problem = previewError()
    if (problem) {
      setError(problem)
      return
    }
    setConfirmation({
      title: upload ? '手机 → 电脑' : '电脑 → 手机',
      text: `${game.name} · ${selectedPeer.device.name}，新建 ${source.files.length} 个文件。`,
      work: async () => {
        await adapter.start({
          deviceId: peerId,
          upload,
          sourceRootId: source.rootId,
          targetRootId: target.rootId,
          targetParentId: target.parentId,
          files: source.files,
          names: targetNames,
          title: `${game.name} · ${selectedPeer.device.name}`,
        })
        setConfirmation(null)
        setPage('task')
      },
    })
  }
  backHandler.current = () => {
    if (confirmation) {
      if (!isBusy) {
        setConfirmation(null)
      }
      return true
    }
    if (isDeviceEditorOpen) {
      setIsDeviceEditorOpen(false)
      return true
    }
    if (isAddGameOpen) {
      closeAddGame()
      return true
    }
    if (isImportOpen) {
      setIsImportOpen(false)
      return true
    }
    if (isGameMenuOpen) {
      setIsGameMenuOpen(false)
      return true
    }
    if (page !== 'games') {
      goBack()
      return true
    }
    return false
  }
  let body: React.ReactNode
  if (page === 'devices') {
    body = (
      <DevicesPage
        peers={peers}
        online={online}
        copied={copied}
        isBusy={isBusy}
        isDisabled={isDisabled}
        isActive={isActive}
        onCopyAddress={copyAddress}
        onAddDevice={() => deviceEditor(null)}
        onDeviceAction={actOnDevice}
        onManageDevice={deviceEditor}
      />
    )
  } else if (page === 'games') {
    body = (
      <GamesPage
        games={config.games}
        online={online}
        hasTasks={Boolean(snapshot?.tasks.length)}
        hasImportableGames={Boolean(importable.length)}
        isDisabled={isDisabled}
        isActive={isActive}
        onOpenGame={openGame}
        onOpenImport={() => {
          setImportKey('')
          setIsImportOpen(true)
        }}
        onAddGame={addGame}
        onOpenTasks={() => setPage('task')}
      />
    )
  } else if (page === 'edit' && game) {
    body = (
      <GameSettingsPage
        key={game.id}
        game={game}
        peers={peers}
        localRoot={localRoot}
        linkPeerId={linkPeerId}
        linkGameId={linkGameId}
        isDisabled={isDisabled}
        isActive={isActive}
        onRename={renameGame}
        onChooseDirectory={chooseDirectory}
        onUnlink={unlinkGame}
        onLinkPeerChange={changeLinkPeer}
        onLinkGameChange={setLinkGameId}
        onLink={linkGame}
        onManageDevices={() => setPage('devices')}
      />
    )
  } else if ((page === 'transfer' || page === 'preview') && game) {
    body = (
      <>
        {/* 隐藏目录页以保留当前层级和勾选，预览使用独立页面内容。 */}
        <div hidden={page === 'preview'}>
          <div className="page-stack">
            <TransferPage
              adapter={adapter}
              game={game}
              peers={peers}
              selectedPeer={selectedPeer}
              remoteGame={remoteGame}
              localRoot={localRoot}
              peerId={peerId}
              upload={upload}
              isDisabled={isDisabled}
              isActive={isActive}
              onPeerChange={changePeer}
              onUploadChange={changeUpload}
              onLocalLocation={setLocalLocation}
              onRemoteLocation={setRemoteLocation}
              onOpenSettings={() => setPage('edit')}
            />
          </div>
        </div>
        {page === 'preview' && (
          <TransferPreviewPage
            source={source}
            targetNames={targetNames}
            isDisabled={isDisabled || isActive}
            previewMessage={previewError()}
            onTargetNameChange={(entryId, value) =>
              setTargetNames((values) => ({ ...values, [entryId]: value }))
            }
          />
        )}
      </>
    )
  } else if (page === 'task') {
    body = (
      <TaskPage
        tasks={snapshot?.tasks ?? []}
        isBusy={isBusy}
        onCancel={(id) => run(() => adapter.cancel(id))}
        onCleanup={() => run(() => adapter.cleanup())}
      />
    )
  } else if (page === 'backup') {
    body = <BackupPage />
  } else if (page === 'settings') {
    body = <SettingsPage />
  } else {
    body = <EmptyState description="请选择游戏" />
  }
  const footer =
    (page === 'transfer' || page === 'preview') && game ? (
      <footer className="library-transfer-action">
        <Button
          color="primary"
          block
          disabled={
            isDisabled ||
            isActive ||
            !source?.files.length ||
            !target ||
            !selectedPeer?.isConnected ||
            (page === 'preview' && Boolean(previewError()))
          }
          onClick={() => (page === 'preview' ? start() : setPage('preview'))}
        >
          {page === 'preview' ? '开始传输' : '预览本次变化'}
        </Button>
      </footer>
    ) : null
  const dialogs = (
    <>
      <AddGameDialog
        isOpen={isAddGameOpen}
        directory={newDirectory}
        gameName={newGameName}
        isBusy={isBusy}
        error={error}
        onChooseDirectory={chooseNewDirectory}
        onGameNameChange={setNewGameName}
        onCancel={closeAddGame}
        onConfirm={confirmAddGame}
      />
      <GameMenu
        isOpen={isGameMenuOpen}
        gameName={game?.name ?? null}
        onClose={() => setIsGameMenuOpen(false)}
      >
        <GameActions
          isActive={isActive}
          onTransfer={() => go('transfer')}
          onSettings={() => go('edit')}
          onBackup={() => go('backup')}
          onTasks={() => go('task')}
          onRemove={removeGame}
        />
      </GameMenu>
      <DeviceEditorDialog
        isOpen={isDeviceEditorOpen}
        editingDeviceId={editingDeviceId}
        deviceName={deviceName}
        deviceAddress={deviceAddress}
        isBusy={isBusy}
        isActive={isActive}
        onDeviceNameChange={setDeviceName}
        onDeviceAddressChange={setDeviceAddress}
        onCancel={() => setIsDeviceEditorOpen(false)}
        onSave={saveDevice}
        onRemove={removeDevice}
      />
      <ImportGameDialog
        isOpen={isImportOpen}
        importKey={importKey}
        isBusy={isBusy}
        options={importable.map((item) => ({
          value: item.key,
          label: `${item.peer.device.name} / ${item.item.name}`,
        }))}
        onImportKeyChange={setImportKey}
        onCancel={() => setIsImportOpen(false)}
        onImport={importGame}
      />
      <ConfirmationDialog
        confirmation={confirmation}
        isBusy={isBusy}
        onCancel={() => {
          if (!isBusy) {
            setConfirmation(null)
          }
        }}
        onConfirm={() => {
          if (confirmation) {
            run(confirmation.work)
          }
        }}
      />
    </>
  )
  return (
    <LibraryShell
      page={page}
      title={PAGE_TITLES[page]}
      gameName={game?.name ?? null}
      error={error}
      isBusy={isBusy}
      footer={footer}
      dialogs={dialogs}
      onBack={goBack}
      onNavigate={go}
      onCloseError={() => setError('')}
      onRetry={() => run(async () => {})}
    >
      {body}
    </LibraryShell>
  )
}
