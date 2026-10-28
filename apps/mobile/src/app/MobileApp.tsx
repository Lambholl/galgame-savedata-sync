import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import { EmptyState } from '../components/EmptyState'
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
import type { MobileLibraryAdapter, MobileSnapshot } from '../platform/library-types'
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
import { SyncCopyPage } from '../features/transfer/SyncCopyPage'
import { SyncTaskDetails } from '../features/transfer/SyncTaskDetails'
import { useSyncTasks } from '../features/transfer/use-sync-tasks'
import { transferFeedback } from '../features/transfer/transfer-feedback'
import type { MobileSyncAdapter } from '../platform/sync-adapter'
import '../styles/mobile.css'

import { AddGameDialog } from '../features/games/AddGameDialog'

const EMPTY = emptyLibrary()

/** 移动应用状态与返回栈；传输由原生持有，页面切换保留任务。 */
export function MobileApp({
  adapter,
  sync,
  backButton,
}: {
  readonly adapter: MobileLibraryAdapter
  readonly sync: MobileSyncAdapter
  readonly backButton?: BackButtonController
}): React.JSX.Element {
  const [messageApi, messageContextHolder] = message.useMessage()
  const syncTasks = useSyncTasks(sync)
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
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const transferNotices = useRef(new Map<string, string>())
  const showSyncFailure = useCallback(
    (content: string) => {
      void messageApi.error({ content, duration: 3.5, key: 'sync-action-failed' })
    },
    [messageApi],
  )
  const showSyncPlan = useCallback(() => {
    setPage((current) => (current === 'sync' ? 'sync-plan' : current))
  }, [])
  useEffect(() => {
    const state = syncTasks.copy?.state
    if (!state) {
      return
    }
    const feedback = transferFeedback(state)
    const signature = feedback ? `${feedback.type}/${feedback.content}` : 'running'
    const previous = transferNotices.current.get(state.jobId)
    if (previous === signature) {
      return
    }
    if (previous === undefined && transferNotices.current.size >= 32) {
      const oldest = transferNotices.current.keys().next().value
      if (oldest !== undefined) {
        transferNotices.current.delete(oldest)
      }
    }
    transferNotices.current.set(state.jobId, signature)
    // 首次取回旧终态只展示详情；本次发起预先登记 running，快速完成也能提示一次。
    if (previous !== undefined && feedback) {
      void messageApi.open({ ...feedback, key: `sync-transfer-${state.jobId}`, duration: 3.5 })
    }
  }, [syncTasks.copy, messageApi])
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++generation.current
    const value = await adapter.read()
    if (version === generation.current) {
      if (
        snapshotRef.current?.peers.some(
          (peer) =>
            peer.isConnected &&
            !value.peers.some((next) => next.device.id === peer.device.id && next.isConnected),
        )
      ) {
        void messageApi.info({ content: '连接已断开', key: 'connection-disconnected' })
      }
      const connected = value.peers.find(
        (peer) =>
          peer.isConnected &&
          snapshotRef.current &&
          !snapshotRef.current.peers.some(
            (previous) => previous.device.id === peer.device.id && previous.isConnected,
          ),
      )
      if (connected) {
        void messageApi.success({
          content: `已连接到 ${connected.device.name}`,
          key: 'connection-connected',
        })
      }
      snapshotRef.current = value
      setSnapshot(value)
      if (value.warning) {
        setError(value.warning)
      }
    }
  }, [adapter, messageApi])
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      if (!isCurrent) {
        return
      }
      if (!operating.current) {
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
          showSyncFailure(message)
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
  const localRoot = snapshot?.roots.find((item) => item.rootId === game?.rootId) ?? null
  const isActive = (snapshot?.tasks.some(taskIsActive) ?? false) || syncTasks.isActive
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
    setIsGameMenuOpen(true)
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
    void messageApi.error({
      content: `连接失败：${message}`,
      duration: 3.5,
      key: 'connection-failed',
    })
  }
  function go(value: Page): void {
    setIsGameMenuOpen(false)
    setPage(value)
  }
  function confirmSync(value: Confirmation): void {
    setConfirmation({
      ...value,
      work: async () => {
        await value.work()
        setConfirmation(null)
        syncTasks.reload()
      },
    })
  }
  function openBackup(projectId: string): void {
    setGameId(projectId)
    setPage('backup')
  }
  function goBack(): void {
    setPage(page === 'sync-plan' ? 'sync' : 'games')
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
        hasTasks={Boolean(snapshot?.tasks.length || syncTasks.copy || syncTasks.restore)}
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
  } else if ((page === 'sync' || page === 'sync-plan') && game) {
    body = (
      <SyncCopyPage
        adapter={adapter}
        key={game.id}
        sync={sync}
        game={game}
        peers={peers}
        localRoot={localRoot}
        peerId={peerId}
        isPlan={page === 'sync-plan'}
        isDisabled={isDisabled || isActive}
        onPeerChange={setPeerId}
        onConfirm={confirmSync}
        onPlanReady={showSyncPlan}
        onFailure={showSyncFailure}
        onStarted={(jobId) => {
          if (!transferNotices.current.has(jobId) && transferNotices.current.size >= 32) {
            const oldest = transferNotices.current.keys().next().value
            if (oldest !== undefined) {
              transferNotices.current.delete(oldest)
            }
          }
          transferNotices.current.set(jobId, 'running')
          void messageApi.info({ content: '开始传输', key: `sync-transfer-${jobId}` })
          syncTasks.reload()
          setPage('task')
        }}
        onSettings={() => setPage('edit')}
        onBackup={() => openBackup(game.id)}
      />
    )
  } else if (page === 'task') {
    body = (
      <>
        <SyncTaskDetails
          sync={sync}
          copy={syncTasks.copy}
          restore={syncTasks.restore}
          games={config.games}
          peers={peers}
          roots={snapshot?.roots ?? []}
          errors={syncTasks.errors}
          onChanged={syncTasks.reload}
          onRescan={(projectId, deviceId) => {
            setGameId(projectId)
            setPeerId(deviceId)
            setPage('sync')
          }}
          onBackup={openBackup}
        />
        {Boolean(snapshot?.tasks.length) && (
          <TaskPage
            tasks={snapshot?.tasks ?? []}
            isBusy={isBusy}
            onCancel={(id) => run(() => adapter.cancel(id))}
            onCleanup={() => run(() => adapter.cleanup())}
          />
        )}
      </>
    )
  } else if (page === 'backup') {
    body = game ? (
      <BackupPage
        key={game.id}
        sync={sync}
        game={game}
        restore={syncTasks.restore}
        isDisabled={isDisabled || isActive}
        onConfirm={confirmSync}
        onChanged={syncTasks.reload}
        onSettings={() => setPage('edit')}
      />
    ) : (
      <EmptyState description="请选择游戏查看本机备份" />
    )
  } else if (page === 'settings') {
    body = <SettingsPage />
  } else {
    body = <EmptyState description="请选择游戏" />
  }
  const dialogs = (
    <>
      {messageContextHolder}
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
          onTransfer={() => go('sync')}
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
      footer={null}
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
