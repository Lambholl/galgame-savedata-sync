import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionSheet, Button } from 'antd-mobile'
import { DownloadOutlined, MoreOutlined, PlusOutlined, ScanOutlined } from '@ant-design/icons'
import { EmptyState } from '../components/EmptyState'
import {
  OperationFailure,
  createConnectionCandidates,
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
  ConnectionQrPayload,
  DirectoryReference,
  InterruptedWrite,
  LibraryGame,
  LibraryPeer,
  ShownError,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter, MobileSnapshot } from '../platform/library-types'
import { deviceDiscovery, findDevice } from '../platform/device-discovery'
import type { DiscoveredDevice } from '../platform/device-discovery'
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
  usePageNavigation,
  useT,
} from '@savedata-sync/shared/ui'
import { useAppMessage } from './app-message'
import { useFailureMessage } from './failure-message'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import type { BackButtonController, Confirmation, Page, PageContext } from './navigation-types'
import { BackupPage } from '../features/backup/BackupPage'
import { RestorePage } from '../features/backup/RestorePage'
import { DevicesPage } from '../features/devices/DevicesPage'
import { ScanPage } from '../features/devices/ScanPage'
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

/** 已保存设备的原地址连不上后，按设备 ID 在局域网里查找的时长；超过后显示没找到。 */
const DEVICE_LOOKUP_MS = 5_000

/**
 * 判断连接已保存设备的失败是否要按设备 ID 查找：原地址连不上、超时，或这个地址上现在是另一台设备。
 * 版本不同、配置损坏等其他失败换地址也解决不了，直接提示。
 */
function shouldLookUpDevice(cause: unknown): boolean {
  const code = toShownError(cause).code
  return code === 'network-failure' || code === 'timeout' || code === 'session-mismatch'
}

/** 移动应用的根组件，持有应用状态和页面导航；传输在原生层，切页不影响任务。 */
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
  const [appMessage, messageContextHolder] = useAppMessage()
  const [taskProjectId, setTaskProjectId] = useState<string | null>(null)
  const [gameId, setGameId] = useState('')
  const navigation = usePageNavigation<Page, PageContext>({
    initialPage: 'devices',
    homePage: 'games',
    context: { gameId, taskProjectId },
    onRestore: (context) => {
      setGameId(context.gameId)
      setTaskProjectId(context.taskProjectId)
    },
  })
  const { page } = navigation
  const syncTasks = useSyncTasks(sync, page === 'task' ? taskProjectId : null)
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null)
  // 失败用 Message 提示一次，不在页面里放横幅。
  const [showError, failureHolder] = useFailureMessage()
  const [isBusy, setIsBusy] = useState(false)
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
  // 设备页正在连接的设备 ID，行内显示转圈；只在 isBusy 期间有效。
  const [connectingId, setConnectingId] = useState<string | null>(null)
  useEffect(() => {
    if (!isBusy) {
      setConnectingId(null)
    }
  }, [isBusy])
  // 原地址连不上后正在按设备 ID 查找的已保存设备，设备页在这一行显示查找中；只在 isBusy 期间有效。
  const [lookingUpId, setLookingUpId] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [interruptedWrites, setInterruptedWrites] = useState<readonly InterruptedWrite[]>([])
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const transferNotices = useRef(new Map<string, string>())
  const showSyncFailure = useCallback(
    (failure: ShownError) => {
      appMessage.show({
        type: 'error',
        content: <ErrorText error={failure} context={null} />,
        duration: 3.5,
        slot: 'sync-action-failed',
      })
    },
    [appMessage],
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
    // 第一次取回已结束的任务只展示详情；本次发起的任务预先登记 running，完成得再快也能提示一次。
    if (previous !== undefined && feedback) {
      appMessage.show({
        type: feedback.type,
        content: feedback.error ? (
          <ErrorText error={feedback.error} context={t(feedback.text)} />
        ) : (
          t(feedback.text)
        ),
        slot: `sync-transfer-${state.jobId}`,
        duration: 3.5,
      })
    }
  }, [syncTasks.copy, appMessage, t])
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  const snapshotRef = useRef(snapshot)
  // refresh 发现这台设备新连上时提示的文字，代替默认的“已连接到”；提示后清空，开始新的连接时也清空。
  // 连接返回时控制通道可能还没打开，要等之后的某次 refresh 才算连上，所以不能每次 refresh 都清空。
  const connectedNotice = useRef<{ readonly deviceId: string; readonly content: string } | null>(
    null,
  )
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
        appMessage.show({ type: 'info', content: t('app.disconnected'), slot: 'connection' })
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
        const notice = connectedNotice.current
        const isNoticed = notice?.deviceId === connected.device.id
        appMessage.show({
          type: 'success',
          content: isNoticed
            ? notice.content
            : t('app.connectedTo', { name: connected.device.name }),
          slot: 'connection',
        })
        if (isNoticed) {
          connectedNotice.current = null
        }
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
      appMessage.show({
        type: 'info',
        content: t('transfer.started'),
        slot: `sync-transfer-${jobId}`,
      })
      reloadTasks()
    },
    [appMessage, reloadTasks, t],
  )
  useRemoteSync(sync, androidControl, online?.device.id ?? null, isActive, {
    onScan: (_requestId, projectId) => {
      const name = config.games.find((item) => item.id === projectId)?.name ?? t('common.unknown')
      appMessage.show({
        type: 'info',
        content: t('transfer.remoteScanRequest', {
          device: online?.device.name ?? t('common.unknown'),
          name,
        }),
        slot: 'remote-sync-scan',
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
      navigation.openMain('games')
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
  /**
   * 连接已保存的设备。moved 是附近搜到的这台设备，这时先连搜到的地址，最后再试保存的地址；
   * 没有 moved 时连保存的地址，连不上或连到另一台设备再按设备 ID 查找。连上后保存的地址换成实际连上的地址。
   */
  function connectDevice(peer: LibraryPeer, moved: DiscoveredDevice | null): void {
    const id = peer.device.id
    run(async () => {
      connectedNotice.current = null
      setConnectingId(id)
      if (moved !== null) {
        const candidates = createConnectionCandidates(moved.addresses, moved.port)
        const saved = peer.device.address ? [peer.device.address] : []
        const name = await adapter.connectCandidates([...new Set([...candidates, ...saved])], id)
        noteRelocated(name, candidates, peer)
        return
      }
      try {
        await adapter.device(id, 'allow')
      } catch (cause) {
        if (!shouldLookUpDevice(cause)) {
          throw cause
        }
        await relocateDevice(peer)
      }
    }, showConnectionFailure)
  }
  /**
   * 按设备 ID 在局域网里查找已保存的设备，找到后依次连它广播的地址。
   * 查找超时算连接失败：提示改地址或扫码后正常结束，该行恢复成可连接。找到后连不上时 reject，由调用方提示连接失败。
   */
  async function relocateDevice(peer: LibraryPeer): Promise<void> {
    setLookingUpId(peer.device.id)
    const found = await findDevice(deviceDiscovery, peer.device.id, DEVICE_LOOKUP_MS)
    setLookingUpId(null)
    if (found === null) {
      appMessage.show({
        type: 'error',
        content: t('device.lookupFailed', { name: peer.device.name }),
        duration: 3.5,
        slot: 'connection',
      })
      return
    }
    const candidates = createConnectionCandidates(found.addresses, found.port)
    const name = await adapter.connectCandidates(candidates, peer.device.id)
    noteRelocated(name, candidates, peer)
  }
  /**
   * 连上已保存的设备后，用的地址里没有保存的地址时，把“已找到新地址并连接”交给 refresh 提示。
   * run 结束后的 refresh 会提示新连上的设备，直接在这里提示会被它的“已连接到”覆盖。
   */
  function noteRelocated(name: string, candidates: readonly string[], peer: LibraryPeer): void {
    if (peer.device.address === null || !candidates.includes(peer.device.address)) {
      connectedNotice.current = {
        deviceId: peer.device.id,
        content: t('device.relocated', { name }),
      }
    }
  }
  function disconnectDevice(peer: LibraryPeer): void {
    run(() => adapter.device(peer.device.id, 'disconnect'))
  }
  function connectNearby(device: DiscoveredDevice): void {
    run(async () => {
      setConnectingId(device.deviceId)
      await adapter.connectCandidates(
        createConnectionCandidates(device.addresses, device.port),
        device.deviceId,
      )
      appMessage.show({
        type: 'success',
        content: t('app.connectedTo', { name: device.name }),
        slot: 'connection',
      })
    }, showConnectionFailure)
  }
  function openScan(): void {
    if (online) {
      showConnectBlocked(online.device.name)
    } else {
      navigation.open('scan')
    }
  }
  /** 回到设备页并连接扫到的设备。这台设备可能不在任何列表里，所以用 Message 显示连接中。 */
  function connectScanned(payload: ConnectionQrPayload): void {
    navigation.back()
    run(async () => {
      setConnectingId(payload.deviceId)
      appMessage.show({
        type: 'info',
        content: t('device.connecting'),
        duration: 0,
        slot: 'connection',
      })
      const name = await adapter.connectCandidates(
        createConnectionCandidates(payload.addresses, payload.port),
        payload.deviceId,
      )
      appMessage.show({
        type: 'success',
        content: t('app.connectedTo', { name }),
        slot: 'connection',
      })
    }, showConnectionFailure)
  }
  function showConnectBlocked(name: string): void {
    appMessage.show({
      type: 'info',
      content: t('device.disconnectFirst', { name }),
      slot: 'connection',
    })
  }
  function showConnectionFailure(failure: ShownError): void {
    appMessage.show({
      type: 'error',
      content: <ErrorText error={failure} context={t('device.connectFailed')} />,
      duration: 3.5,
      slot: 'connection',
    })
  }
  function go(value: Page): void {
    setIsGameMenuOpen(false)
    navigation.open(value)
  }
  function openTasks(projectId: string | null): void {
    setTaskProjectId(projectId)
    setIsGameMenuOpen(false)
    navigation.open('task')
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
    navigation.open('backup')
  }
  /** 离开恢复页：准备中的取消，未开始或已结束的释放；进行中的恢复继续。 */
  function closeRestore(): void {
    navigation.back()
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
    navigation.back()
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
        navigation.openMain('games')
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
    if (navigation.backTarget) {
      goBack()
      return true
    }
    // 主导航页按返回先回设备页，在设备页再按才退出。
    if (page !== 'devices') {
      navigation.openMain('devices')
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
        connectingId={isBusy ? connectingId : null}
        lookingUpId={isBusy ? lookingUpId : null}
        isDisabled={isDisabled}
        isActive={isActive}
        onConnect={connectDevice}
        onDisconnect={disconnectDevice}
        onManageDevice={deviceEditor}
        onConnectNearby={connectNearby}
        onBlocked={showConnectBlocked}
      />
    )
  } else if (page === 'scan') {
    body = (
      <ScanPage
        onScanned={connectScanned}
        onInvalidCode={() =>
          appMessage.show({ type: 'info', content: t('device.scanInvalid'), slot: 'connection' })
        }
        onManualInput={() => {
          navigation.back()
          deviceEditor(null)
        }}
        onOverlayChange={changePageOverlay}
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
          navigation.open('sync')
        }}
        onManageDevices={() => navigation.open('devices')}
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
        onPreview={() => navigation.open('sync-plan')}
        onPlanExpired={() => {
          appMessage.show({
            type: 'warning',
            content: t('error.code.plan-expired'),
            duration: 3.5,
            slot: 'sync-action-failed',
          })
          navigation.open('sync')
        }}
        onFailure={showSyncFailure}
        onStarted={async (jobId) => {
          announceStart(jobId)
          // 先读到新任务再进详情，否则详情页会先显示上一次的结果。
          await syncTasks.refreshCopy().catch(() => undefined)
          // 开始传输结束本次流程：详情返回游戏页，不回比较或计划。
          setTaskProjectId(game.id)
          navigation.finishFlow('task')
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
            navigation.open('sync')
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
        onSettings={() => navigation.open('edit')}
        onOpenAppSettings={() => navigation.open('settings')}
        onOpenRestore={(restoreId, sourceName) => {
          setRestoreTarget({ restoreId, sourceName })
          syncTasks.reload()
          navigation.open('restore')
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
        onOverlayChange={changePageOverlay}
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
          navigation.open(action.key === 'edit' ? 'edit' : 'backup')
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
      hasBack={navigation.backTarget !== null}
      direction={navigation.direction}
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
        ) : page === 'devices' ? (
          <span className="games-header-actions">
            <Button
              fill="none"
              aria-label={t('device.scan')}
              disabled={isDisabled || isActive}
              onClick={openScan}
            >
              <ScanOutlined />
            </Button>
            <Button
              fill="none"
              aria-label={t('device.addPc')}
              disabled={isDisabled || isActive}
              onClick={() => deviceEditor(null)}
            >
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
      onNavigate={navigation.openMain}
    >
      {body}
    </LibraryShell>
  )
}
