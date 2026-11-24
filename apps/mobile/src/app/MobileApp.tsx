import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActionSheet, Button } from 'antd-mobile'
import { DownloadOutlined, MoreOutlined, PlusOutlined, ScanOutlined } from '@ant-design/icons'
import { EmptyState } from '../components/EmptyState'
import {
  OperationFailure,
  createConnectionCandidates,
  emptyLibrary,
  formatConnectionAddress,
  observeRestoreTask,
  observeSyncJob,
  toShownError,
  withGameLink,
  withoutGameLink,
  withoutGamePoster,
  createImportedGame,
  importPeerPoster,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  ConnectionQrPayload,
  DataResetItem,
  DirectoryReference,
  ImportedPoster,
  InterruptedWrite,
  LibraryGame,
  LibraryPeer,
  PosterImageCandidate,
  PosterImageData,
  PosterOrigin,
  ShownError,
  SyncDirection,
} from '@savedata-sync/shared'
import type { MobileLibraryAdapter, MobileSnapshot } from '../platform/library-types'
import { deviceDiscovery, findDevice } from '../platform/device-discovery'
import type { DiscoveredDevice } from '../platform/device-discovery'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { InterruptedWriteDialog } from '../components/InterruptedWriteDialog.tsx'
import { DataResetDialog } from '../components/DataResetDialog.tsx'
import { dismissDataResets, readDataResets } from '../platform/app-storage'
import { DeviceEditorDialog } from '../components/DeviceEditorDialog.tsx'
import { GameMenu } from '../features/games/GameActionSheet'
import { ImportGameDialog } from '../components/ImportGameDialog.tsx'
import { LibraryShell } from '../components/LibraryShell.tsx'
import { PAGE_TITLE_KEYS } from './navigation-types'
import {
  ErrorText,
  GameActions,
  encodePosterWebp,
  restoreObservationPreview,
  syncTaskPreview,
  usePageNavigation,
  usePosterUrls,
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
import { addNomedia } from './nomedia'
import { SyncCopyPage } from '../features/transfer/SyncCopyPage'
import { SyncTaskDetails } from '../features/transfer/SyncTaskDetails'
import { useSyncTasks } from '../features/transfer/use-sync-tasks'
import { useRemoteSync } from '../features/transfer/use-remote-sync'
import { transferFeedback } from '../features/transfer/transfer-feedback'
import type { MobileSyncAdapter } from '../platform/sync-adapter'
import { androidControl } from '../platform/http-transfers'
import { allFilesAccess } from '../platform/all-files-access'
import { androidPosters } from '../platform/posters'
import '../styles/mobile.css'

import { AddGameDialog } from '../features/games/AddGameDialog'

const EMPTY = emptyLibrary()

/**
 * 连接已保存设备时按设备 ID 在局域网里查找的时长，从开始连接保存的地址算起。
 * 和连接超时相同：原地址不回应时，连接超时的同时查找也结束，约 5 秒得出结果。
 */
const DEVICE_LOOKUP_MS = 5_000

/**
 * 判断连接已保存设备的失败是否要按设备 ID 查找：原地址连不上、超时，或这个地址上现在是另一台设备。
 * 版本不同、配置损坏等其他失败换地址也解决不了，直接提示。
 */
function shouldLookUpDevice(cause: unknown): boolean {
  const code = toShownError(cause).code
  return code === 'network-failure' || code === 'timeout' || code === 'session-mismatch'
}

/** 移动应用的主界面：页面导航、弹层和状态轮询。 */
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
  const [taskKind, setTaskKind] = useState<'copy' | 'restore' | null>(null)
  const [restoreSources, setRestoreSources] = useState<Readonly<Record<string, string>>>({})
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
  // 比较页打开时的方向：从任务详情重新扫描时沿用那次传输的方向；null 表示复制到本机，由比较页按连接角色换算。
  const [syncDirection, setSyncDirection] = useState<SyncDirection | null>(null)
  // 设备页正在连接的设备 ID，行内显示转圈；run 结束时清空。
  const [connectingId, setConnectingId] = useState<string | null>(null)
  // 本机服务正在启动或停止；run 结束时清空。
  const [serviceChange, setServiceChange] = useState<'starting' | 'stopping' | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [interruptedWrites, setInterruptedWrites] = useState<readonly InterruptedWrite[]>([])
  const [dataResets, setDataResets] = useState<readonly DataResetItem[]>([])
  const operating = useRef(false)
  const generation = useRef(0)
  const backHandler = useRef<() => boolean>(() => false)
  const transferNotices = useRef(new Map<string, string>())
  // 原生任务不记录发起方，只在本次运行期间记住对方发起的任务。
  const [peerInitiatedJobIds, setPeerInitiatedJobIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
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
  // 有设备连上或断开本机服务时立即刷新，不等下一次轮询。
  useEffect(
    () =>
      adapter.subscribe(() => {
        if (!operating.current) {
          refresh().catch((cause: unknown) => showError(toShownError(cause)))
        }
      }),
    [adapter, refresh, showError],
  )
  useEffect(() => backButton?.subscribe(() => backHandler.current()), [backButton])
  useEffect(() => {
    let isCurrent = true
    readDataResets()
      .then((items) => {
        if (isCurrent) {
          setDataResets(items)
        }
      })
      .catch((cause: unknown) => showError(toShownError(cause)))
    return () => {
      isCurrent = false
    }
  }, [showError])
  function closeDataResets(): void {
    setDataResets([])
    dismissDataResets().catch((cause: unknown) => showError(toShownError(cause)))
  }
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
        setConnectingId(null)
        setServiceChange(null)
      })
  }
  // 页面重建后第一次读取要等目录和连接查完，这之前先用本机保存的配置，游戏和设备名不会显示成“未知”。
  const savedConfig = useMemo(() => {
    try {
      return adapter.savedConfig()
    } catch {
      return EMPTY
    }
  }, [adapter])
  const config = snapshot?.config ?? savedConfig
  const posterUrls = usePosterUrls(config.games, androidPosters)
  const gameIndex = config.games.findIndex((item) => item.id === gameId)
  const game = config.games[gameIndex] ?? null
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
  const peers =
    snapshot?.peers ??
    savedConfig.devices.map((device) => ({ device, isConnected: false, games: [] }))
  const online = peers.find((item) => item.isConnected) ?? null
  // 连接返回后要等控制通道打开才算在线，这期间仍显示连接中，否则“连接”按钮会再出现一次。
  const opening = peers.find((item) => item.device.id === snapshot?.connectingId) ?? null
  const localRoot = snapshot?.roots.find((item) => item.rootId === game?.rootId) ?? null
  const isActive = syncTasks.isActive
  const isDisabled = isBusy || !snapshot
  const copyProjectId = syncTasks.copy?.preview.binding.projectId ?? null
  // 游戏移除后，它已结束的传输和恢复不再放进任务条，否则任务条留着一条名为“未知”的记录。
  const isStripShown = (projectId: string | null, phase: TaskStripInfo['phase']): boolean =>
    phase === 'running' || config.games.some((item) => item.id === projectId)
  const copyObserved = syncTasks.copy
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
  const copyPreview =
    copyObserved && isStripShown(copyProjectId, copyObserved.phase) ? copyObserved : null
  const restoreObserved = syncTasks.restore
    ? restoreObservationPreview(
        observeRestoreTask({
          ...syncTasks.restore.state,
          cleanupError: syncTasks.restore.state.result?.cleanupError ?? null,
        }),
        t,
      )
    : null
  const restorePreview =
    restoreObserved &&
    isStripShown(syncTasks.restore?.state.projectId ?? null, restoreObserved.phase)
      ? restoreObserved
      : null
  const shouldShowCopy =
    copyPreview && (copyPreview.phase === 'running' || restorePreview?.phase !== 'running')
  const stripProjectId = shouldShowCopy
    ? copyProjectId
    : (syncTasks.restore?.state.projectId ?? null)
  const stripTask: TaskStripInfo | null =
    shouldShowCopy && copyPreview
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
  /** 对方开始的传输和本机发起的一样结束当前流程，打开任务详情，详情返回游戏页。 */
  function openPeerJob(jobId: string, projectId: string): void {
    announceStart(jobId)
    setPeerInitiatedJobIds((ids) => new Set(ids).add(jobId))
    // 应用在后台时也只切页面：Android 不允许后台应用把自己切到前台，进度看传输通知。
    syncTasks
      .refreshCopy()
      .catch(() => undefined)
      .finally(() => {
        setTaskProjectId(projectId)
        setIsGameMenuOpen(false)
        setIsTransferMenuOpen(false)
        navigation.finishFlow('task')
      })
  }
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
    onStarted: openPeerJob,
    onFailure: showSyncFailure,
  })
  const peerJobStarted = useRef(openPeerJob)
  useLayoutEffect(() => {
    peerJobStarted.current = openPeerJob
  })
  // 本机作为监听方时，对方直接开始的任务由本机服务通知。
  useEffect(
    () => sync.onPeerJobStarted((jobId, projectId) => peerJobStarted.current(jobId, projectId)),
    [sync],
  )
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
        const item = { ...game, rootId: result.directory.rootId }
        await saveGame(item)
        addNomedia([item])
      }
    })
  }
  async function savePoster(
    target: LibraryGame,
    image: PosterImageData,
    source: PosterOrigin,
  ): Promise<void> {
    let data: string
    try {
      data = await encodePosterWebp(image)
    } catch (cause) {
      // 解码失败说明选的文件不是能识别的图片，换成能看懂的提示；其他失败照常显示。
      if (cause instanceof OperationFailure && cause.code === 'invalid-request') {
        throw new Error(t('poster.unreadable'), { cause })
      }
      throw cause
    }
    const posterHash = await androidPosters.save(target.id, data)
    await saveGame({ ...target, posterHash, posterSource: source })
    appMessage.show({ type: 'success', content: t('poster.saved'), slot: 'poster' })
  }
  function pickSearchedPoster(candidate: PosterImageCandidate): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!game || operating.current) {
        reject(new Error('busy'))
        return
      }
      run(
        async () => {
          await savePoster(
            game,
            await androidPosters.downloadImage(candidate.downloadUrl),
            candidate.source,
          )
          resolve()
        },
        (failure) => {
          showError(failure)
          reject(new Error(failure.message))
        },
      )
    })
  }
  function pickLocalPoster(): void {
    if (!game) {
      return
    }
    run(async () => {
      const image = await androidPosters.pickImage()
      if (image) {
        await savePoster(game, image, 'local')
      }
    })
  }
  function removePoster(): void {
    if (!game) {
      return
    }
    run(async () => {
      await saveGame(withoutGamePoster(game))
      appMessage.show({ type: 'success', content: t('poster.removed'), slot: 'poster' })
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
        // 导入时名称已预填为另一端的游戏名，选目录时保留它，两端名称才对得上。
        if (!importedGame) {
          setNewGameName(
            (result.directory.parentName ?? result.directory.displayName).trim().slice(0, 128),
          )
        }
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
      const id = crypto.randomUUID()
      const remotePosterHash = imported?.game.posterHash ?? null
      let poster: ImportedPoster | null = null
      let hasPosterFailed = false
      if (imported && remotePosterHash !== null) {
        // 先存封面文件再保存游戏，游戏只写一次配置；取不到封面时游戏照常导入。
        try {
          poster = await importPeerPoster(
            id,
            remotePosterHash,
            () => adapter.peerPoster(imported.deviceId, imported.game.id),
            (gameId, data) => androidPosters.save(gameId, data),
          )
        } catch (cause) {
          console.error('Failed to import the peer poster', cause)
          hasPosterFailed = true
        }
      }
      // 取封面期间配置可能已被对端的目录表交换改写，在取完之后再读。
      const current = snapshotRef.current?.config
      if (!current) {
        throw new Error(t('app.notLoaded'))
      }
      const item: LibraryGame = imported
        ? {
            ...createImportedGame(id, imported.game, imported.deviceId),
            name,
            rootId: directory.rootId,
            ...poster,
          }
        : {
            id,
            name,
            rootId: directory.rootId,
            links: [],
          }
      await adapter.saveGames([...current.games, item])
      addNomedia([item])
      if (hasPosterFailed) {
        appMessage.show({ type: 'warning', content: t('poster.importFailed'), slot: 'poster' })
      }
      setGameId(item.id)
      setPeerId(imported?.deviceId ?? '')
      setIsAddGameOpen(false)
      setNewDirectory(null)
      setNewGameName('')
      setImportedGame(null)
      navigation.openMain('games')
      promptDirectAccess().catch((cause: unknown) => {
        console.error('Failed to prompt for all-files access', cause)
      })
    })
  }
  /** 没有所有文件访问权限时，第一次添加游戏后提示开启一次。 */
  async function promptDirectAccess(): Promise<void> {
    const state = await allFilesAccess.status()
    if (!state || state.isGranted || state.wasPrompted) {
      return
    }
    await allFilesAccess.markPrompted()
    setConfirmation({
      title: t('directAccess.prompt.title'),
      text: t('directAccess.prompt.text'),
      okText: t('directAccess.prompt.ok'),
      work: async () => {
        await allFilesAccess.openSettings()
        setConfirmation(null)
      },
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
   * 连接已保存的设备。moved 是附近搜到的这台设备，这时先连搜到的地址，最后再试保存的地址。
   * 没有 moved 时连保存的地址，同时在后台按设备 ID 查找，界面上只显示连接中；保存的地址连上就停止查找。
   * 保存的地址连不上或连到另一台设备时，查到了就连查到的地址，没查到时提示保存的地址连接失败的原因。
   * 连上后保存的地址换成实际连上的地址。
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
      const lookup = new AbortController()
      const found = findDevice(deviceDiscovery, id, DEVICE_LOOKUP_MS, lookup.signal)
      try {
        await adapter.device(id, 'allow')
      } catch (cause) {
        const device = shouldLookUpDevice(cause) ? await found : null
        if (device === null) {
          throw cause
        }
        const candidates = createConnectionCandidates(device.addresses, device.port)
        noteRelocated(await adapter.connectCandidates(candidates, id), candidates, peer)
      } finally {
        lookup.abort()
      }
    }, showConnectionFailure)
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
  function toggleService(): void {
    const status = snapshot?.service
    if (!status) {
      return
    }
    const isRunning = status.listener !== null
    run(async () => {
      setServiceChange(isRunning ? 'stopping' : 'starting')
      await adapter.service(isRunning ? 'stop' : 'start')
    })
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
    const current = online ?? opening
    if (current) {
      showConnectBlocked(current.device.name)
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
  function openTasks(projectId: string | null, kind: 'copy' | 'restore' | null = null): void {
    setTaskProjectId(projectId)
    setTaskKind(kind)
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
  /** 新关联或更换关联游戏；保存成功后 resolve，失败已提示并 reject。 */
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
    setNewGameName(choice.item.name)
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
    if (dataResets.length > 0) {
      closeDataResets()
      return true
    }
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
        service={snapshot?.service ?? null}
        serviceChange={serviceChange}
        peers={peers}
        online={online}
        connectingId={connectingId ?? opening?.device.id ?? null}
        isDisabled={isDisabled}
        isActive={isActive}
        onConnect={connectDevice}
        onDisconnect={disconnectDevice}
        onManageDevice={deviceEditor}
        onConnectNearby={connectNearby}
        onBlocked={showConnectBlocked}
        onToggleService={toggleService}
        onRandomizePort={() => run(() => adapter.service('randomize-port'))}
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
        posterUrls={posterUrls}
        online={online}
        isConnectionKnown={snapshot !== null}
        task={stripTask}
        onOpenGame={openGame}
        onOpenTasks={() => openTasks(stripProjectId, shouldShowCopy ? 'copy' : 'restore')}
      />
    )
  } else if (page === 'edit' && game) {
    body = (
      <GameSettingsPage
        key={game.id}
        game={game}
        peers={peers}
        localRoot={localRoot}
        posterUrl={posterUrls.get(game.id) ?? null}
        coverIndex={gameIndex}
        posters={androidPosters}
        isDisabled={isDisabled}
        isActive={isActive}
        onRename={renameGame}
        onChooseDirectory={chooseDirectory}
        onPickSearchedPoster={pickSearchedPoster}
        onPickPoster={pickLocalPoster}
        onRemovePoster={removePoster}
        onLink={linkGame}
        onUnlink={unlinkGame}
        onTransfer={(deviceId) => {
          setPeerId(deviceId)
          setSyncDirection(null)
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
        isLocalListener={snapshot?.listenerPeerIds.includes(peerId) ?? false}
        initialDirection={syncDirection}
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
          setTaskKind('copy')
          navigation.finishFlow('task')
        }}
      />
    )
  } else if (page === 'task') {
    const taskRestore =
      taskProjectId === null || syncTasks.restore?.state.projectId === taskProjectId
        ? syncTasks.restore
        : null
    body = (
      <SyncTaskDetails
        key={`${taskProjectId ?? 'all'}/${taskKind ?? 'auto'}`}
        projectId={taskProjectId}
        initialKind={taskKind}
        sync={sync}
        copy={taskProjectId === null ? syncTasks.copy : syncTasks.projectCopy}
        isLoading={syncTasks.isProjectCopyLoading}
        restore={taskRestore}
        restoreSourceName={
          taskRestore ? (restoreSources[taskRestore.state.restoreId] ?? null) : null
        }
        games={config.games}
        peers={peers}
        errors={syncTasks.errors}
        peerInitiatedJobIds={peerInitiatedJobIds}
        onChanged={() => syncTasks.reload()}
        onRescan={(projectId, deviceId, direction) => {
          setGameId(projectId)
          setPeerId(deviceId)
          setSyncDirection(direction)
          navigation.open('sync')
        }}
        onBackup={openBackup}
      />
    )
  } else if (page === 'backup') {
    body = game ? (
      <BackupPage
        key={game.id}
        sync={sync}
        game={game}
        restore={syncTasks.restore}
        isDisabled={isDisabled || isActive}
        onChanged={() => syncTasks.reload()}
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
        onStarted={async (restoreId, sourceName) => {
          setRestoreSources((current) => ({ ...current, [restoreId]: sourceName }))
          setRestoreTarget(null)
          // 先读到进行中的恢复再切页，避免详情页短暂显示旧任务。
          await syncTasks.refreshRestore().catch(() => undefined)
          setTaskProjectId(game?.id ?? null)
          setTaskKind('restore')
          navigation.finishFlow('task')
        }}
        onChanged={() => syncTasks.reload()}
        onFailure={showSyncFailure}
      />
    )
  } else if (page === 'settings') {
    body = (
      <SettingsPage
        sync={sync}
        games={config.games}
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
          onTransfer={() => {
            setSyncDirection(null)
            go('sync')
          }}
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
      <DataResetDialog items={dataResets} onClose={closeDataResets} />
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
      onNavigate={(target) => navigation.openMain(target)}
    >
      {body}
    </LibraryShell>
  )
}
