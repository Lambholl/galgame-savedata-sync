import { useCallback, useEffect, useRef, useState } from 'react'
import { Empty } from 'antd'
import {
  emptyLibrary,
  taskIsActive,
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
import type { DesktopSnapshot } from '../platform/library-types.ts'
import { createDesktopLibraryAdapter } from '../platform/library-adapter.ts'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { DeviceEditorDialog } from '../features/devices/DeviceEditorDialog.tsx'
import { GameActions } from '../features/games/GameActions.tsx'
import { GameActionDialog } from '../features/games/GameActionDialog.tsx'
import { ImportGameDialog } from '../features/games/ImportGameDialog.tsx'
import { DesktopShell } from './DesktopShell.tsx'
import { PAGE_TITLES } from './navigation.ts'
import type { Confirmation, Page } from './navigation.ts'
import { BackupPage } from '../features/backup/BackupPage.tsx'
import { DevicesPage } from '../features/devices/DevicesPage.tsx'
import { GamesPage } from '../features/games/GamesPage.tsx'
import { GameSettingsPage } from '../features/games/GameSettingsPage.tsx'
import { SettingsPage } from '../features/settings/SettingsPage.tsx'
import { TaskPage } from '../features/transfer/TaskPage.tsx'
import { TransferPage } from '../features/transfer/TransferPage.tsx'

import { AddGameDialog } from '../features/games/AddGameDialog'

const EMPTY = emptyLibrary()
const ADAPTER = createDesktopLibraryAdapter()

/** 桌面页面、弹窗与轮询由本端持有；原生任务切页后继续运行。 */
export function DesktopApp(): React.JSX.Element {
  const adapter = ADAPTER
  const [page, setPage] = useState<Page>('games')
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [gameId, setGameId] = useState('')
  const [peerId, setPeerId] = useState('')
  const [isGameActionDialogOpen, setIsGameActionDialogOpen] = useState(false)
  const [isDeviceEditorOpen, setIsDeviceEditorOpen] = useState(false)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [deviceName, setDeviceName] = useState('')
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
  const [portDraft, setPort] = useState<number | null | undefined>(undefined)
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [isDark, setIsDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const operating = useRef(false)
  const generation = useRef(0)
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
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setIsDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
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
  function run(work: () => Promise<void>): void {
    if (operating.current) {
      return
    }
    operating.current = true
    generation.current++
    setIsBusy(true)
    setError('')
    work()
      .then(refresh)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : '操作失败，请重试。'),
      )
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  const config = snapshot?.config ?? EMPTY
  const port = portDraft === undefined ? (snapshot?.service?.port ?? null) : portDraft
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
    setIsGameActionDialogOpen(true)
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
  function deviceEditor(id: string): void {
    const item = config.devices.find((value) => value.id === id)
    setEditingDeviceId(id)
    setDeviceName(item?.name ?? '')
    setIsDeviceEditorOpen(true)
  }
  function saveDevice(): void {
    run(async () => {
      if (!editingDeviceId) {
        return
      }
      await adapter.device(editingDeviceId, 'rename', deviceName.trim())
      setIsDeviceEditorOpen(false)
    })
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
  function toggleService(): void {
    const service = snapshot?.service
    if (!service) {
      return
    }
    if (service.isRunning && isActive) {
      setConfirmation({
        title: '停止服务',
        text: '将断开设备，并取消当前传输。',
        work: async () => {
          await adapter.service(false, port ?? service.port)
          setConfirmation(null)
        },
      })
    } else {
      run(() => adapter.service(!service.isRunning, port ?? service.port))
    }
  }
  function actOnDevice(peer: LibraryPeer): void {
    if (peer.isConnected) {
      run(() => adapter.device(peer.device.id, 'disconnect'))
    }
  }
  function go(value: Page): void {
    setIsGameActionDialogOpen(false)
    setPage(value)
  }
  function changePeer(id: string): void {
    setPeerId(id)
    setPage('transfer')
  }
  function changeUpload(isUpload: boolean): void {
    setUpload(isUpload)
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
    setIsGameActionDialogOpen(false)
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
  let body: React.ReactNode
  if (page === 'devices') {
    body = (
      <DevicesPage
        snapshot={snapshot}
        peers={peers}
        copied={copied}
        port={port}
        isBusy={isBusy}
        isDisabled={isDisabled}
        isActive={isActive}
        onPortChange={setPort}
        onRandomizePort={() => run(async () => setPort(await adapter.randomizePort()))}
        onToggleService={toggleService}
        onCopyAddress={copyAddress}
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
  } else if (page === 'transfer' && game) {
    body = (
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
        onOpenSettings={() => setPage('edit')}
      />
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
    body = <Empty description="请选择游戏" />
  }
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
      <GameActionDialog
        isOpen={isGameActionDialogOpen}
        gameName={game?.name ?? null}
        onClose={() => setIsGameActionDialogOpen(false)}
      >
        <GameActions
          isActive={isActive}
          onTransfer={() => go('transfer')}
          onSettings={() => go('edit')}
          onBackup={() => go('backup')}
          onTasks={() => go('task')}
          onRemove={removeGame}
        />
      </GameActionDialog>
      <DeviceEditorDialog
        isOpen={isDeviceEditorOpen}
        editingDeviceId={editingDeviceId}
        deviceName={deviceName}
        isBusy={isBusy}
        isActive={isActive}
        onDeviceNameChange={setDeviceName}
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
    <DesktopShell
      isDark={isDark}
      page={page}
      title={PAGE_TITLES[page]}
      gameName={game?.name ?? null}
      error={error}
      isBusy={isBusy}
      dialogs={dialogs}
      onBack={() => setPage('games')}
      onNavigate={go}
      onCloseError={() => setError('')}
      onRetry={() => run(async () => {})}
    >
      {body}
    </DesktopShell>
  )
}
