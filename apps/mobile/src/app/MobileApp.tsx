import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import { ActionSheet, Button } from 'antd-mobile'
import { DownloadOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons'
import { EmptyState } from '../components/EmptyState'
import {
  OperationFailure,
  emptyLibrary,
  formatConnectionAddress,
  observeSyncJob,
  taskIsActive,
  toShownError,
  withGameLink,
  withoutGameLink,
  createImportedGame,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  DirectoryReference,
  InterruptedWrite,
  LibraryGame,
  LibraryPeer,
  ShownError,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter, MobileSnapshot } from '../platform/library-types'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { InterruptedWriteDialog } from '../components/InterruptedWriteDialog.tsx'
import { DeviceEditorDialog } from '../components/DeviceEditorDialog.tsx'
import { GameMenu } from '../features/games/GameActionSheet'
import { ImportGameDialog } from '../components/ImportGameDialog.tsx'
import { LibraryShell } from '../components/LibraryShell.tsx'
import { PAGE_TITLE_KEYS } from './navigation-types'
import {
  ErrorText,
  GameActions,
  legacyTaskPreview,
  restoreTaskPreview,
  syncTaskPreview,
  useT,
} from '@savedata-sync/shared/ui'
import { useFailureMessage } from './failure-message'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import type { BackButtonController, Confirmation, Page } from './navigation-types'
import { BackupPage } from '../features/backup/BackupPage'
import { RestorePage } from '../features/backup/RestorePage'
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
  const [page, setPage] = useState<Page>('games')
  const [taskProjectId, setTaskProjectId] = useState<string | null>(null)
  const syncTasks = useSyncTasks(sync, page === 'task' ? taskProjectId : null)
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null)
  // 失败用 Message 提示一次，不在页面里放横幅。
  const [showError, failureHolder] = useFailureMessage()
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
  /** 恢复页显示的那次恢复，以及计划里来源一端的名称。 */
  const [restoreTarget, setRestoreTarget] = useState<{
    readonly restoreId: string
    readonly sourceName: string
  } | null>(null)
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [interruptedWrites, setInterruptedWrites] = useState<readonly InterruptedWrite[]>([])
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const transferNotices = useRef(new Map<string, string>())
  const scanNotice = useRef<string | null>(null)
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
      // 开始和结果不共用 key：提示退场时用同一 key 再次打开，计时不会重启，提示就一直不消失。
      messageApi.destroy(`sync-started-${state.jobId}`)
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
        showError({ code: null, message: value.warning })
      }
    }
  }, [adapter, messageApi, showError, t])
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
            showError(toShownError(cause))
          }
        }
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch((cause: unknown) => showError(toShownError(cause)))
        }, 1800)
      }
    }
    poll().catch((cause: unknown) => showError(toShownError(cause)))
    return () => {
      isCurrent = false
      invalidate()
      clearTimeout(timer)
    }
  }, [refresh, invalidate, showError])
  useEffect(() => backButton?.subscribe(() => backHandler.current()), [backButton])
  // 游戏名要等配置读到才有；已移除的游戏没有可提示的目录，标记直接清除。
  const hasLoaded = snapshot !== null
  useEffect(() => {
    if (!hasLoaded) {
      return
    }
    let isCurrent = true
    sync
      .interruptedWrites()
      .then(async (writes) => {
        const games = snapshotRef.current?.config.games ?? []
        const isKnown = (item: InterruptedWrite): boolean =>
          games.some((value) => value.id === item.projectId)
        for (const item of writes.filter((value) => !isKnown(value))) {
          await sync.dismissInterruptedWrite(item.id)
        }
        if (isCurrent) {
          setInterruptedWrites(writes.filter(isKnown))
        }
      })
      .catch((cause: unknown) => showError(toShownError(cause)))
    return () => {
      isCurrent = false
    }
  }, [hasLoaded, sync, showError])
  function run(work: () => Promise<void>, onError?: (failure: ShownError) => void): void {
    if (operating.current) {
      return
    }
    operating.current = true
    generation.current++
    setIsBusy(true)
    showError(null)
    work()
      .then(refresh)
      .catch((cause: unknown) => {
        const failure = toShownError(cause)
        if (onError) {
          onError(failure)
        } else {
          showError(failure)
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
  const interruptedWrite = interruptedWrites[0] ?? null
  function dismissInterruptedWrite(): void {
    if (!interruptedWrite) {
      return
    }
    setInterruptedWrites((items) => items.filter((item) => item.id !== interruptedWrite.id))
    sync
      .dismissInterruptedWrite(interruptedWrite.id)
      .catch((cause: unknown) => showError(toShownError(cause)))
  }
  const peers = snapshot?.peers ?? []
  const online = peers.find((item) => item.isConnected) ?? null
  const localRoot = snapshot?.roots.find((item) => item.rootId === game?.rootId) ?? null
  const isActive = (snapshot?.tasks.some(taskIsActive) ?? false) || syncTasks.isActive
  const isDisabled = isBusy || !snapshot
  const copyProjectId = syncTasks.copy?.preview.binding.projectId ?? null
  const copyPreview = syncTasks.copy
    ? syncTaskPreview(
        observeSyncJob(
          syncTasks.copy.state.local,
          syncTasks.copy.state.remote,
          syncTasks.copy.state.remoteError !== null,
        ),
        t,
      )
    : null
  const openRestore =
    syncTasks.restore?.state.restoreId === restoreTarget?.restoreId ? syncTasks.restore : null
  const restorePreview = syncTasks.restore
    ? restoreTaskPreview(
        syncTasks.restore.state.status,
        Boolean(syncTasks.restore.state.result?.cleanupError),
        t,
      )
    : null
  const legacy = snapshot?.tasks.find(taskIsActive) ?? snapshot?.tasks.at(-1) ?? null
  const shouldShowCopy =
    copyPreview && (copyPreview.phase === 'running' || restorePreview?.phase !== 'running')
  const shouldShowLegacy = legacy && (taskIsActive(legacy) || (!copyPreview && !restorePreview))
  const stripProjectId = shouldShowLegacy
    ? null
    : shouldShowCopy
      ? copyProjectId
      : (syncTasks.restore?.state.projectId ?? null)
  const stripTask: TaskStripInfo | null = shouldShowLegacy
    ? { ...legacyTaskPreview(legacy, t), gameName: legacy.title }
    : shouldShowCopy && copyPreview
      ? {
          ...copyPreview,
          gameName:
            config.games.find((item) => item.id === copyProjectId)?.name ?? t('common.unknown'),
        }
      : restorePreview
        ? {
            ...restorePreview,
            gameName:
              config.games.find((item) => item.id === stripProjectId)?.name ?? t('common.unknown'),
          }
        : null
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
      void messageApi.info({ content: t('transfer.started'), key: `sync-started-${jobId}` })
      reloadTasks()
    },
    [messageApi, reloadTasks, t],
  )
  useRemoteSync(sync, androidControl, online?.device.id ?? null, isActive, {
    onScan: (requestId, projectId) => {
      const name = config.games.find((item) => item.id === projectId)?.name ?? t('common.unknown')
      // 每次请求一个 key，并收起上一条；原因同上。
      if (scanNotice.current) {
        messageApi.destroy(scanNotice.current)
      }
      scanNotice.current = `remote-sync-scan-${requestId}`
      void messageApi.info({
        content: t('transfer.remoteScanRequest', { name }),
        key: scanNotice.current,
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
    // 优先选已连接的设备；都没连接时，只有一台才能替用户定下来。
    const connected = item.links.find((link) =>
      peers.some((peer) => peer.isConnected && peer.device.id === link.deviceId),
    )
    setPeerId((connected ?? (item.links.length === 1 ? item.links[0] : undefined))?.deviceId ?? '')
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
      showError({ code: null, message: t('game.nameRequired') })
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
    showError(null)
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
    showError(null)
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
    setDeviceAddress(formatConnectionAddress(item?.address ?? ''))
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
      await navigator.clipboard.writeText(formatConnectionAddress(address))
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
  function openTasks(projectId: string | null): void {
    setTaskProjectId(projectId)
    setIsGameMenuOpen(false)
    setPage('task')
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
  /** 离开恢复页：准备中的取消，未开始或已结束的释放；进行中的恢复继续。 */
  function closeRestore(): void {
    setPage('backup')
    const id = restoreTarget?.restoreId
    const status = restoreTarget && openRestore?.state.status
    setRestoreTarget(null)
    if (!id || status === 'running') {
      return
    }
    ;(status === 'preparing' || !status ? sync.cancelRestore(id) : sync.releaseRestore(id))
      .catch((cause: unknown) => showSyncFailure(toShownError(cause)))
      .finally(syncTasks.reload)
  }
  function goBack(): void {
    if (page === 'restore') {
      closeRestore()
      return
    }
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
          showError(failure)
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
    showError(null)
    setIsImportOpen(false)
    setIsAddGameOpen(true)
  }
  function removeGame(): void {
    setIsGameMenuOpen(false)
    setConfirmation({
      title: t('game.removeTitle'),
      text: t('game.removeText'),
      work: async () => {
        // 先删备份：删除失败时游戏还在，可以重试，不会留下没有入口的备份。
        await sync.deleteGameBackups(gameId)
        await adapter.saveGames(config.games.filter((item) => item.id !== gameId))
        setConfirmation(null)
        setPage('games')
      },
    })
  }
  backHandler.current = () => {
    if (interruptedWrite) {
      dismissInterruptedWrite()
      return true
    }
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
        task={stripTask}
        onOpenGame={openGame}
        onOpenTasks={() =>
          !shouldShowLegacy && !shouldShowCopy && stripProjectId
            ? openBackup(stripProjectId)
            : openTasks(stripProjectId)
        }
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
        deviceName={snapshot?.deviceName ?? null}
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
          openTasks(game.id)
        }}
      />
    )
  } else if (page === 'task') {
    body = (
      <>
        <SyncTaskDetails
          projectId={taskProjectId}
          sync={sync}
          copy={taskProjectId === null ? syncTasks.copy : syncTasks.projectCopy}
          isLoading={syncTasks.isProjectCopyLoading}
          restore={
            taskProjectId === null || syncTasks.restore?.state.projectId === taskProjectId
              ? syncTasks.restore
              : null
          }
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
        {taskProjectId === null && Boolean(snapshot?.tasks.length) && (
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
        onOpenRestore={(restoreId, sourceName) => {
          setRestoreTarget({ restoreId, sourceName })
          syncTasks.reload()
          setPage('restore')
        }}
        onOverlayChange={changePageOverlay}
      />
    ) : (
      <EmptyState description={t('backup.noGame')} />
    )
  } else if (page === 'restore' && restoreTarget) {
    body = (
      <RestorePage
        key={restoreTarget.restoreId}
        sync={sync}
        restore={openRestore}
        rootId={game?.rootId ?? null}
        sourceName={restoreTarget.sourceName}
        isDisabled={isDisabled || isActive}
        onChanged={syncTasks.reload}
        onDone={closeRestore}
        onFailure={showSyncFailure}
      />
    )
  } else if (page === 'settings') {
    body = (
      <SettingsPage
        sync={sync}
        preferences={appPreferences}
        onChange={(next) => {
          setAppPreferences(next).catch((failure: unknown) => {
            console.error('Failed to save app preferences', failure)
            showError({ code: null, message: t('settings.saveFailed') })
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
      {failureHolder}
      <AddGameDialog
        isOpen={isAddGameOpen}
        directory={newDirectory}
        gameName={newGameName}
        isBusy={isBusy}
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
          caption={`${localRoot?.displayName ?? t('game.noFolder')} · ${t('game.linkCount', { count: game?.links.length ?? 0 })}`}
          isRemoveDisabled={isActive}
          onTransfer={() => go('sync')}
          onSettings={() => go('edit')}
          onBackup={() => go('backup')}
          onTasks={() => openTasks(game?.id ?? null)}
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
      <InterruptedWriteDialog
        gameName={
          interruptedWrite
            ? (config.games.find((item) => item.id === interruptedWrite.projectId)?.name ?? null)
            : null
        }
        hasBackup={Boolean(interruptedWrite?.backupId)}
        onViewBackup={() => {
          if (interruptedWrite) {
            openBackup(interruptedWrite.projectId)
            dismissInterruptedWrite()
          }
        }}
        onClose={dismissInterruptedWrite}
      />
    </>
  )
  return (
    <LibraryShell
      page={page}
      title={t(PAGE_TITLE_KEYS[page])}
      gameName={game?.name ?? null}
      footer={null}
      headerAction={
        page === 'games' ? (
          <span className="games-header-actions">
            <Button
              fill="none"
              aria-label={t('game.importGame')}
              disabled={isDisabled || !importable.length}
              onClick={() => {
                setImportKey('')
                setIsImportOpen(true)
              }}
            >
              <DownloadOutlined />
            </Button>
            <Button fill="none" aria-label={t('game.add')} disabled={isDisabled} onClick={addGame}>
              <PlusOutlined />
            </Button>
          </span>
        ) : page === 'sync' ? (
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
    >
      {body}
    </LibraryShell>
  )
}
