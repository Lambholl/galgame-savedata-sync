import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Empty, Tooltip } from 'antd'
import { ControlOutlined, HistoryOutlined } from '@ant-design/icons'
import {
  emptyLibrary,
  formatConnectionAddress,
  withGameLink,
  withoutGameLink,
  createImportedGame,
  OperationFailure,
  toShownError,
  taskIsActive,
  unwrap,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  DirectoryReference,
  InterruptedWrite,
  LibraryGame,
  LibraryPeer,
} from '@savedata-sync/shared'
import type { DesktopSnapshot } from '../platform/library-types.ts'
import { createDesktopLibraryAdapter } from '../platform/library-adapter.ts'
import { desktopBackups, desktopSync } from '../platform/sync-adapter.ts'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { InterruptedWriteDialog } from '../components/InterruptedWriteDialog.tsx'
import { DeviceEditorDialog } from '../features/devices/DeviceEditorDialog.tsx'
import { GameActionDialog } from '../features/games/GameActionDialog.tsx'
import { ImportGameDialog } from '../features/games/ImportGameDialog.tsx'
import { DesktopShell } from './DesktopShell.tsx'
import type { AppPreferencesState } from './use-app-preferences.ts'
import {
  GameActions,
  legacyTaskPreview,
  restoreTaskPreview,
  syncTaskPreview,
  useT,
} from '@savedata-sync/shared/ui'
import { useAppMessage } from './app-message.ts'
import { useFailureMessage } from './failure-message.ts'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import { PAGE_TITLE_KEYS } from './navigation.ts'
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
const COPY_MESSAGE_TYPES = {
  done: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'info',
  unknown: 'warning',
} as const

export function DesktopApp({
  appPreferences,
}: {
  readonly appPreferences: AppPreferencesState
}): React.JSX.Element {
  const t = useT()
  const adapter = ADAPTER
  const [appMessage, messageContextHolder] = useAppMessage()
  const [page, setPage] = useState<Page>('games')
  const [taskProjectId, setTaskProjectId] = useState<string | null>(null)
  const [taskCopyId, setTaskCopyId] = useState<string | null>(null)
  const [taskRestoreId, setTaskRestoreId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null)
  // 失败用 Message 提示一次，不在页面里放横幅。
  const [showError, failureHolder] = useFailureMessage()
  const [isBusy, setIsBusy] = useState(false)
  const [gameId, setGameId] = useState('')
  const [backupRootId, setBackupRootId] = useState<string | null>(null)
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
  const [upload, setUpload] = useState(false)
  const [portDraft, setPort] = useState<number | null | undefined>(undefined)
  const [copied, setCopied] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [interruptedWrites, setInterruptedWrites] = useState<readonly InterruptedWrite[]>([])

  const operating = useRef(false)
  const generation = useRef(0)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++generation.current
    const value = await adapter.read(t)
    if (version === generation.current) {
      if (
        snapshotRef.current?.peers.some(
          (peer) =>
            peer.isConnected &&
            !value.peers.some((next) => next.device.id === peer.device.id && next.isConnected),
        )
      ) {
        appMessage.show({ type: 'info', content: t('app.disconnected'), slot: 'connection' })
      }
      snapshotRef.current = value
      setSnapshot(value)
      if (value.warning) {
        showError({ code: null, message: value.warning })
      }
    }
  }, [adapter, appMessage, showError, t])
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
  // 传输结束时用 Message 提示一次结果；打开应用时已结束的旧任务只在详情里看。
  const copyStatuses = useRef<ReadonlyMap<string, string> | null>(null)
  useEffect(() => {
    if (!snapshot) {
      return
    }
    const previous = copyStatuses.current
    copyStatuses.current = new Map(snapshot.copies.map((item) => [item.jobId, item.phase]))
    if (!previous) {
      return
    }
    for (const item of snapshot.copies) {
      const before = previous.get(item.jobId)
      if (item.phase === 'running' || (before !== undefined && before !== 'running')) {
        continue
      }
      const name = snapshot.config.games.find((game) => game.id === item.projectId)?.name
      appMessage.show({
        type: COPY_MESSAGE_TYPES[item.phase],
        content: `${name ?? t('common.unknown')} · ${syncTaskPreview(item, t).status}`,
        slot: `sync-transfer-${item.jobId}`,
        duration: 3.5,
      })
    }
  }, [snapshot, appMessage, t])
  // 游戏名要等配置读到才有；已移除的游戏没有可提示的目录，标记直接清除。
  const hasLoaded = snapshot !== null
  useEffect(() => {
    if (!hasLoaded) {
      return
    }
    let isCurrent = true
    desktopSync()
      .interruptedWrites()
      .then(async (result) => {
        const writes = unwrap(result)
        const games = snapshotRef.current?.config.games ?? []
        const isKnown = (item: InterruptedWrite): boolean =>
          games.some((value) => value.id === item.projectId)
        for (const item of writes.filter((value) => !isKnown(value))) {
          unwrap(await desktopSync().dismissInterruptedWrite(item.id))
        }
        if (isCurrent) {
          setInterruptedWrites(writes.filter(isKnown))
        }
      })
      .catch((cause: unknown) => showError(toShownError(cause)))
    return () => {
      isCurrent = false
    }
  }, [hasLoaded, showError])
  function run(work: () => Promise<void>): void {
    if (operating.current) {
      return
    }
    operating.current = true
    generation.current++
    setIsBusy(true)
    showError(null)
    work()
      .then(refresh)
      .catch((cause: unknown) => showError(toShownError(cause)))
      .finally(() => {
        operating.current = false
        setIsBusy(false)
      })
  }
  const config = snapshot?.config ?? EMPTY
  const port = portDraft === undefined ? (snapshot?.service?.port ?? null) : portDraft
  const game = config.games.find((item) => item.id === gameId) ?? null
  const interruptedWrite = interruptedWrites[0] ?? null
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
  const isActive = snapshot?.hasActiveOperation ?? false
  const hasRunningNetworkWork = Boolean(
    snapshot?.tasks.some((task) => task.local?.status === 'running') ||
    snapshot?.copies.some((task) => task.phase === 'running'),
  )
  const hasRunningWork =
    hasRunningNetworkWork || Boolean(snapshot?.restores.some((task) => task.isWorking))
  const isDisabled = isBusy || !snapshot
  const copiesByRecent = [...(snapshot?.copies ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const copy = copiesByRecent.find((item) => item.phase === 'running') ?? copiesByRecent[0] ?? null
  const gameCopy = copiesByRecent.find((item) => item.projectId === game?.id) ?? null
  const restoresByRecent = [...(snapshot?.restores ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const restore = restoresByRecent.find((item) => item.isWorking) ?? restoresByRecent[0] ?? null
  const copyPreview = copy ? syncTaskPreview(copy, t) : null
  const legacy = snapshot?.tasks.find(taskIsActive) ?? snapshot?.tasks.at(-1) ?? null
  const shouldShowLegacy = legacy && (taskIsActive(legacy) || (!copy && !restore))
  const shouldShowCopy =
    copy &&
    (copy.phase === 'running' ||
      !restore ||
      (!restore.isWorking && copy.updatedAt >= restore.updatedAt))
  const stripProjectId = shouldShowLegacy
    ? null
    : shouldShowCopy
      ? copy.projectId
      : (restore?.projectId ?? null)
  const stripTask: TaskStripInfo | null = shouldShowLegacy
    ? { ...legacyTaskPreview(legacy, t), gameName: legacy.title }
    : shouldShowCopy && copyPreview
      ? {
          ...copyPreview,
          gameName:
            config.games.find((item) => item.id === copy.projectId)?.name ?? t('common.unknown'),
        }
      : restore
        ? {
            ...restoreTaskPreview(restore.status, restore.hasCleanupError, t),
            gameName:
              config.games.find((item) => item.id === restore.projectId)?.name ??
              t('common.unknown'),
          }
        : null
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
    setBackupRootId(null)
    // 优先选已连接的设备；都没连接时，只有一台才能替用户定下来。
    const connected = item.links.find((link) =>
      peers.some((peer) => peer.isConnected && peer.device.id === link.deviceId),
    )
    setPeerId((connected ?? (item.links.length === 1 ? item.links[0] : undefined))?.deviceId ?? '')
    setIsGameActionDialogOpen(true)
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
  function toggleService(): void {
    const service = snapshot?.service
    if (!service) {
      return
    }
    if (service.isRunning && hasRunningNetworkWork) {
      setConfirmation({
        title: t('service.stopTitle'),
        text: t('service.stopText'),
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
    if (value === 'backup') {
      setBackupRootId(null)
    }
    setPage(value)
  }
  function openTasks(
    projectId: string | null,
    copyId: string | null,
    restoreId: string | null = null,
  ): void {
    setTaskProjectId(projectId)
    setTaskCopyId(copyId)
    setTaskRestoreId(restoreId)
    setIsGameActionDialogOpen(false)
    setPage('task')
  }
  function openBackup(projectId: string, rootId: string): void {
    setGameId(projectId)
    setBackupRootId(rootId)
    setPage('backup')
  }
  function dismissInterruptedWrite(): void {
    if (!interruptedWrite) {
      return
    }
    setInterruptedWrites((items) => items.filter((item) => item.id !== interruptedWrite.id))
    desktopSync()
      .dismissInterruptedWrite(interruptedWrite.id)
      .then(unwrap)
      .catch((cause: unknown) => showError(toShownError(cause)))
  }
  function tasksChanged(): void {
    void refresh().catch((cause: unknown) => showError(toShownError(cause)))
  }
  function changePeer(id: string): void {
    setPeerId(id)
    setPage('transfer')
  }
  function changeUpload(isUpload: boolean): void {
    setUpload(isUpload)
    setPage('transfer')
  }
  function unlinkGame(deviceId: string): void {
    if (!game) {
      return
    }
    run(() => saveGame(withoutGameLink(game, deviceId)))
  }
  /** 新关联或改为对应其他游戏；保存成功后 resolve，失败显示错误并 reject。 */
  function linkGame(deviceId: string, remoteGameId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!game || operating.current) {
        reject(new Error('busy'))
        return
      }
      const base = game.links.some((link) => link.deviceId === deviceId)
        ? withoutGameLink(game, deviceId)
        : game
      run(async () => {
        try {
          await saveGame(withGameLink(base, deviceId, remoteGameId))
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)))
          throw cause
        }
        setPeerId(deviceId)
        resolve()
      })
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
    setIsGameActionDialogOpen(false)
    setConfirmation({
      title: t('game.removeTitle'),
      text: t('game.removeText'),
      work: async () => {
        // 先删备份：删除失败时游戏还在，可以重试，不会留下没有入口的备份。
        unwrap(await desktopBackups().deleteGameBackups(gameId))
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
        task={stripTask}
        hasImportableGames={Boolean(importable.length)}
        isDisabled={isDisabled}
        onOpenGame={openGame}
        onOpenImport={() => {
          setImportKey('')
          setIsImportOpen(true)
        }}
        onAddGame={addGame}
        onOpenTasks={() =>
          openTasks(
            stripProjectId,
            !shouldShowLegacy && shouldShowCopy ? copy.jobId : null,
            !shouldShowLegacy && !shouldShowCopy ? (restore?.restoreId ?? null) : null,
          )
        }
      />
    )
  } else if (page === 'edit' && game) {
    body = (
      <GameSettingsPage
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
          setPage('transfer')
        }}
        onManageDevices={() => setPage('devices')}
      />
    )
  } else if (page === 'transfer' && game) {
    body = (
      <TransferPage
        key={game.id}
        game={game}
        peers={peers}
        selectedPeer={selectedPeer}
        remoteGame={remoteGame}
        localRoot={localRoot}
        deviceName={snapshot?.deviceName ?? null}
        peerId={peerId}
        upload={upload}
        isDisabled={isDisabled}
        isActive={isActive}
        onPeerChange={changePeer}
        onUploadChange={changeUpload}
        onConfirm={(value) =>
          setConfirmation({
            ...value,
            work: async () => {
              await value.work()
              setConfirmation(null)
            },
          })
        }
        onStarted={() => {
          // 先读到新任务再进详情，否则详情页会先显示上一次的结果。
          refresh()
            .catch((cause: unknown) => showError(toShownError(cause)))
            .finally(() => openTasks(game.id, null))
        }}
        onPlanExpired={() =>
          appMessage.show({
            type: 'warning',
            content: t('error.code.plan-expired'),
            duration: 3.5,
            slot: 'plan-expired',
          })
        }
      />
    )
  } else if (page === 'task') {
    body = (
      <TaskPage
        key={`${taskProjectId ?? 'all'}/${taskCopyId ?? 'recent'}/${taskRestoreId ?? ''}`}
        initialCopyId={taskCopyId}
        initialRestoreId={taskRestoreId}
        projectId={taskProjectId}
        tasks={taskProjectId === null ? (snapshot?.tasks ?? []) : []}
        copies={
          snapshot?.copies.filter(
            (item) => taskProjectId === null || item.projectId === taskProjectId,
          ) ?? []
        }
        restores={
          snapshot?.restores.filter(
            (item) => taskProjectId === null || item.projectId === taskProjectId,
          ) ?? []
        }
        games={config.games}
        peers={peers}
        isActive={isActive}
        isBusy={isBusy}
        onCancel={(id) => run(() => adapter.cancel(id))}
        onCleanup={() => run(() => adapter.cleanup())}
        onChanged={tasksChanged}
        onOpenBackup={openBackup}
        onRescan={(projectId, deviceId) => {
          setGameId(projectId)
          setPeerId(deviceId)
          setPage('transfer')
        }}
      />
    )
  } else if (page === 'backup') {
    body = (
      <BackupPage
        key={`${gameId}/${backupRootId ?? game?.rootId ?? ''}`}
        roots={snapshot?.roots ?? []}
        game={game}
        rootId={backupRootId ?? game?.rootId ?? null}
        isActive={isActive}
        hasRunningWork={hasRunningWork}
        onOpenSettings={() => setPage('edit')}
        onOpenAppSettings={() => setPage('settings')}
        onChanged={tasksChanged}
      />
    )
  } else if (page === 'settings') {
    body = (
      <SettingsPage
        preferences={appPreferences.preferences}
        onChange={(next) => {
          appPreferences
            .save(next)
            .then((failure) => {
              if (failure) {
                showError(failure)
              }
            })
            .catch((failure: unknown) => {
              console.error('Failed to save app preferences', failure)
              showError({ code: null, message: t('settings.saveFailed') })
            })
        }}
      />
    )
  } else {
    body = <Empty description={t('game.pickOne')} />
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
      <GameActionDialog
        isOpen={isGameActionDialogOpen}
        gameName={game?.name ?? null}
        onClose={() => setIsGameActionDialogOpen(false)}
      >
        <GameActions
          caption={`${localRoot?.displayName ?? t('game.noFolder')} · ${t('game.linkCount', { count: game?.links.length ?? 0 })}`}
          isRemoveDisabled={isActive}
          onTransfer={() => go('transfer')}
          onSettings={() => go('edit')}
          onBackup={() => go('backup')}
          onTasks={() => openTasks(game?.id ?? null, gameCopy?.jobId ?? null)}
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
      <InterruptedWriteDialog
        gameName={
          interruptedWrite
            ? (config.games.find((item) => item.id === interruptedWrite.projectId)?.name ?? null)
            : null
        }
        hasBackup={Boolean(interruptedWrite?.backupId)}
        onViewBackup={() => {
          if (interruptedWrite) {
            openBackup(interruptedWrite.projectId, interruptedWrite.rootId)
            dismissInterruptedWrite()
          }
        }}
        onClose={dismissInterruptedWrite}
      />
    </>
  )
  return (
    <DesktopShell
      theme={appPreferences.theme}
      page={page}
      title={t(PAGE_TITLE_KEYS[page])}
      gameName={game?.name ?? null}
      headerAction={
        page === 'transfer' && game ? (
          <>
            <Tooltip title={t('page.gameSettings')}>
              <Button
                type="text"
                icon={<ControlOutlined />}
                aria-label={t('page.gameSettings')}
                onClick={() => setPage('edit')}
              />
            </Tooltip>
            <Tooltip title={t('page.backup')}>
              <Button
                type="text"
                icon={<HistoryOutlined />}
                aria-label={t('page.backup')}
                onClick={() => (game.rootId ? openBackup(game.id, game.rootId) : go('backup'))}
              />
            </Tooltip>
          </>
        ) : null
      }
      dialogs={dialogs}
      onBack={() => setPage('games')}
      onNavigate={go}
    >
      {body}
    </DesktopShell>
  )
}
