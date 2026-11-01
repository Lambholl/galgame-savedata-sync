import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import { ActionSheet, Button } from 'antd-mobile'
import { MoreOutlined } from '@ant-design/icons'
import { EmptyState } from '../components/EmptyState'
import {
  OperationFailure,
  emptyLibrary,
  taskIsActive,
  toShownError,
  withGameLink,
  withoutGameLink,
  createImportedGame,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  ShownError,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter, MobileSnapshot } from '../platform/library-types'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { DeviceEditorDialog } from '../components/DeviceEditorDialog.tsx'
import { GameActions } from '../features/games/GameActions'
import { GameMenu } from '../features/games/GameActionSheet'
import { ImportGameDialog } from '../components/ImportGameDialog.tsx'
import { LibraryShell } from '../components/LibraryShell.tsx'
import { PAGE_TITLE_KEYS } from './navigation-types'
import { ErrorText, useT } from '@savedata-sync/shared/ui'
import type { BackButtonController, Confirmation, Page } from './navigation-types'
import { BackupPage } from '../features/backup/BackupPage'
import { DevicesPage } from '../features/devices/DevicesPage'
import { GamesPage } from '../features/games/GamesPage'
import { GameSettingsPage } from '../features/games/GameSettingsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { setAppPreferences, useAppPreferences } from './app-preferences'
import { TaskPage } from '../features/transfer/TaskPage'
import { SyncCopyPage } from '../features/transfer/SyncCopyPage'
import { SyncTaskDetails } from '../features/transfer/SyncTaskDetails'
import { useSyncTasks } from '../features/transfer/use-sync-tasks'
import { useRemoteSync } from '../features/transfer/use-remote-sync'
import { transferFeedback } from '../features/transfer/transfer-feedback'
import type { MobileSyncAdapter } from '../platform/sync-adapter'
import { androidControl } from '../platform/http-transfers'
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
  const appPreferences = useAppPreferences()
  const t = useT()
  const [messageApi, messageContextHolder] = message.useMessage()
  const syncTasks = useSyncTasks(sync)
  const [page, setPage] = useState<Page>('games')
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null)
  const [error, setError] = useState<ShownError | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [gameId, setGameId] = useState('')
  const [peerId, setPeerId] = useState('')
  const [isGameMenuOpen, setIsGameMenuOpen] = useState(false)
  const [isTransferMenuOpen, setIsTransferMenuOpen] = useState(false)
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
  const [closePageOverlay, setClosePageOverlay] = useState<(() => void) | null>(null)
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const transferNotices = useRef(new Map<string, string>())
  const showSyncFailure = useCallback(
    (failure: ShownError) => {
      void messageApi.error({
        content: <ErrorText error={failure} context={null} />,
        duration: 3.5,
        key: 'sync-action-failed',
      })
    },
    [messageApi],
  )
  const changePageOverlay = useCallback(
    (close: (() => void) | null) => setClosePageOverlay(() => close),
    [],
  )
  useEffect(() => {
    const state = syncTasks.copy?.state
    if (!state) {
      return
    }
    const feedback = transferFeedback(state)
    const signature = feedback ? `${feedback.type}/${feedback.text}` : 'running'
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
      void messageApi.open({
        type: feedback.type,
        content: feedback.error ? (
          <ErrorText error={feedback.error} context={t(feedback.text)} />
        ) : (
          t(feedback.text)
        ),
        key: `sync-transfer-${state.jobId}`,
        duration: 3.5,
      })
    }
  }, [syncTasks.copy, messageApi, t])
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
        void messageApi.info({ content: t('app.disconnected'), key: 'connection-disconnected' })
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
          content: t('app.connectedTo', { name: connected.device.name }),
          key: 'connection-connected',
        })
      }
      snapshotRef.current = value
      setSnapshot(value)
      if (value.warning) {
        setError({ code: null, message: value.warning })
      }
    }
  }, [adapter, messageApi, t])
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
            setError(toShownError(cause))
          }
        }
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch((cause: unknown) => setError(toShownError(cause)))
        }, 1800)
      }
    }
    poll().catch((cause: unknown) => setError(toShownError(cause)))
    return () => {
      isCurrent = false
      invalidate()
      clearTimeout(timer)
    }
  }, [refresh, invalidate])
  useEffect(() => backButton?.subscribe(() => backHandler.current()), [backButton])
  function run(work: () => Promise<void>, onError?: (failure: ShownError) => void): void {
    if (operating.current) {
      return
    }
    operating.current = true
    generation.current++
    setIsBusy(true)
    setError(null)
    work()
      .then(refresh)
      .catch((cause: unknown) => {
        const failure = toShownError(cause)
        if (onError) {
          onError(failure)
        } else {
          setError(failure)
          showSyncFailure(failure)
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
  const { reload: reloadTasks } = syncTasks
  const announceStart = useCallback(
    (jobId: string) => {
      if (!transferNotices.current.has(jobId) && transferNotices.current.size >= 32) {
        const oldest = transferNotices.current.keys().next().value
        if (oldest !== undefined) {
          transferNotices.current.delete(oldest)
        }
      }
      transferNotices.current.set(jobId, 'running')
      void messageApi.info({ content: t('transfer.started'), key: `sync-transfer-${jobId}` })
      reloadTasks()
    },
    [messageApi, reloadTasks, t],
  )
  useRemoteSync(sync, androidControl, online?.device.id ?? null, isActive, {
    onScan: (projectId) => {
      const name = config.games.find((item) => item.id === projectId)?.name ?? t('common.unknown')
      void messageApi.info({
        content: t('transfer.remoteScanRequest', { name }),
        key: 'remote-sync-scan',
      })
    },
    onStarted: announceStart,
    onFailure: showSyncFailure,
  })
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
      throw new Error(t('app.notLoaded'))
    }
    await adapter.saveGames(current.games.map((value) => (value.id === item.id ? item : value)))
  }
  function renameGame(value: string): void {
    if (!game) {
      return
    }
    const name = value.trim()
    if (!name) {
      setError({ code: null, message: t('game.nameRequired') })
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
        throw new OperationFailure(result.error.code, result.error.message)
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
    setError(null)
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
    setError(null)
  }
  function chooseNewDirectory(): void {
    run(async () => {
      const result = await adapter.chooseDirectory()
      if (result.status === 'error') {
        throw new OperationFailure(result.error.code, result.error.message)
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
        throw new Error(t('app.notLoaded'))
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
      title: t('device.removeTitle'),
      text: t('device.removeText'),
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
  function showConnectionFailure(failure: ShownError): void {
    void messageApi.error({
      content: <ErrorText error={failure} context={t('device.connectFailed')} />,
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
  function unlinkGame(deviceId: string): void {
    if (!game) {
      return
    }
    run(() => saveGame(withoutGameLink(game, deviceId)))
  }
  /** 新关联或改为对应其他游戏；保存成功后 resolve，失败已提示并 reject。 */
  function linkGame(deviceId: string, remoteGameId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!game || operating.current) {
        reject(new Error('busy'))
        return
      }
      const base = game.links.some((link) => link.deviceId === deviceId)
        ? withoutGameLink(game, deviceId)
        : game
      run(
        async () => {
          await saveGame(withGameLink(base, deviceId, remoteGameId))
          setPeerId(deviceId)
          resolve()
        },
        (failure) => {
          setError(failure)
          showSyncFailure(failure)
          reject(new Error(failure.message))
        },
      )
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
    setError(null)
    setIsImportOpen(false)
    setIsAddGameOpen(true)
  }
  function removeGame(): void {
    setIsGameMenuOpen(false)
    setConfirmation({
      title: t('game.removeTitle'),
      text: t('game.removeText'),
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
    if (isTransferMenuOpen) {
      setIsTransferMenuOpen(false)
      return true
    }
    if (closePageOverlay) {
      closePageOverlay()
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
        isDisabled={isDisabled}
        isActive={isActive}
        onRename={renameGame}
        onChooseDirectory={chooseDirectory}
        onLink={linkGame}
        onUnlink={unlinkGame}
        onTransfer={(deviceId) => {
          setPeerId(deviceId)
          setPage('sync')
        }}
        onManageDevices={() => setPage('devices')}
        onOverlayChange={changePageOverlay}
      />
    )
  } else if ((page === 'sync' || page === 'sync-plan') && game) {
    body = (
      <SyncCopyPage
        key={game.id}
        sync={sync}
        game={game}
        peers={peers}
        localRoot={localRoot}
        peerId={peerId}
        isPlan={page === 'sync-plan'}
        isDisabled={isDisabled || isActive}
        isTransferActive={isActive}
        onPeerChange={setPeerId}
        onConfirm={confirmSync}
        onPreview={() => setPage('sync-plan')}
        onFailure={showSyncFailure}
        onStarted={(jobId) => {
          announceStart(jobId)
          setPage('task')
        }}
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
        onChanged={syncTasks.reload}
        onSettings={() => setPage('edit')}
        onOpenAppSettings={() => setPage('settings')}
        onOverlayChange={changePageOverlay}
      />
    ) : (
      <EmptyState description={t('backup.noGame')} />
    )
  } else if (page === 'settings') {
    body = (
      <SettingsPage
        sync={sync}
        preferences={appPreferences}
        onChange={(next) => {
          setAppPreferences(next).catch((failure: unknown) => {
            console.error('Failed to save app preferences', failure)
            setError({ code: null, message: t('settings.saveFailed') })
          })
        }}
      />
    )
  } else {
    body = <EmptyState description={t('game.pickOne')} />
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
      <ActionSheet
        visible={isTransferMenuOpen}
        cancelText={t('common.cancel')}
        actions={[
          { key: 'edit', text: t('page.gameSettings') },
          { key: 'backup', text: t('page.backup') },
        ]}
        onAction={(action) => {
          setIsTransferMenuOpen(false)
          setPage(action.key === 'edit' ? 'edit' : 'backup')
        }}
        onClose={() => setIsTransferMenuOpen(false)}
      />
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
      title={t(PAGE_TITLE_KEYS[page])}
      gameName={game?.name ?? null}
      error={error}
      isBusy={isBusy}
      footer={null}
      headerAction={
        page === 'sync' ? (
          <Button
            fill="none"
            aria-label={t('common.more')}
            onClick={() => setIsTransferMenuOpen(true)}
          >
            <MoreOutlined />
          </Button>
        ) : null
      }
      dialogs={dialogs}
      onBack={goBack}
      onNavigate={go}
      onCloseError={() => setError(null)}
      onRetry={() => run(async () => {})}
    >
      {body}
    </LibraryShell>
  )
}
