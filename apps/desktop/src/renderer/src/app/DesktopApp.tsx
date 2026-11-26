import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Empty, Tooltip } from 'antd'
import { ControlOutlined, HistoryOutlined } from '@ant-design/icons'
import {
  emptyLibrary,
  formatConnectionAddress,
  gameTransferBlocker,
  withGameLink,
  withoutGameLink,
  withoutGamePoster,
  createImportedGame,
  importPeerPoster,
  OperationFailure,
  toShownError,
  unwrap,
} from '@savedata-sync/shared'
import type {
  CatalogGame,
  DataResetItem,
  DirectoryReference,
  ImportedPoster,
  InterruptedWrite,
  LibraryGame,
  LibraryPeer,
  PosterImageCandidate,
  PosterImageData,
  PosterOrigin,
} from '@savedata-sync/shared'
import type { DesktopSnapshot } from '../platform/library-types.ts'
import type { DesktopDialResult, DesktopNearbyDevice } from '../../../bridge/dialer-bridge.ts'
import { createDesktopLibraryAdapter } from '../platform/library-adapter.ts'
import { createDesktopPosterAdapter } from '../platform/poster-adapter.ts'
import { desktopBackups, desktopDataReset, desktopSync } from '../platform/sync-adapter.ts'
import { ConfirmationDialog } from '../components/ConfirmationDialog.tsx'
import { InterruptedWriteDialog } from '../components/InterruptedWriteDialog.tsx'
import { DataResetDialog } from '../components/DataResetDialog.tsx'
import { DeviceEditorDialog } from '../features/devices/DeviceEditorDialog.tsx'
import { AddDeviceDialog } from '../features/devices/AddDeviceDialog.tsx'
import { GameActionDialog } from '../features/games/GameActionDialog.tsx'
import { ImportGameDialog } from '../features/games/ImportGameDialog.tsx'
import { DesktopShell } from './DesktopShell.tsx'
import type { AppPreferencesState } from './use-app-preferences.ts'
import {
  GameActions,
  restoreObservationPreview,
  syncTaskPreview,
  usePageNavigation,
  useT,
} from '@savedata-sync/shared/ui'
import { useAppMessage } from './app-message.ts'
import { useShowFailure } from './failure-message.ts'
import { encodePosterImage, usePosterUrls } from '@savedata-sync/shared/ui'
import type { TaskStripInfo } from '@savedata-sync/shared/ui'
import { PAGE_TITLE_KEYS } from './navigation.ts'
import type { Confirmation, Page, PageContext } from './navigation.ts'
import { BackupPage } from '../features/backup/BackupPage.tsx'
import { DevicesPage } from '../features/devices/DevicesPage.tsx'
import { GamesPage } from '../features/games/GamesPage.tsx'
import { GameSettingsPage } from '../features/games/GameSettingsPage.tsx'
import { PosterSearchModal } from '../features/games/PosterSearchModal.tsx'
import { SettingsPage } from '../features/settings/SettingsPage.tsx'
import { TaskPage } from '../features/transfer/TaskPage.tsx'
import { TransferPage } from '../features/transfer/TransferPage.tsx'

import { AddGameDialog } from '../features/games/AddGameDialog'

const EMPTY = emptyLibrary()
const ADAPTER = createDesktopLibraryAdapter()
// 搜索按来源限流排队，整个窗口共用一个适配器。
const POSTERS = createDesktopPosterAdapter()

const COPY_MESSAGE_TYPES = {
  done: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'info',
  unknown: 'warning',
} as const

/** 桌面应用的主界面：页面导航、弹窗和状态轮询。 */
export function DesktopApp({
  appPreferences,
}: {
  readonly appPreferences: AppPreferencesState
}): React.JSX.Element {
  const t = useT()
  const adapter = ADAPTER
  const [appMessage, messageContextHolder] = useAppMessage()
  const [taskProjectId, setTaskProjectId] = useState<string | null>(null)
  const [taskCopyId, setTaskCopyId] = useState<string | null>(null)
  const [taskRestoreId, setTaskRestoreId] = useState<string | null>(null)
  const [restoreSources, setRestoreSources] = useState<Readonly<Record<string, string>>>({})
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null)
  // 失败用 Message 提示一次，不在页面里放横幅。
  const showError = useShowFailure(appMessage)
  const [isBusy, setIsBusy] = useState(false)
  const [gameId, setGameId] = useState('')
  const pageContext: PageContext = {
    gameId,
    taskProjectId,
    taskCopyId,
    taskRestoreId,
  }
  const navigation = usePageNavigation<Page, PageContext>({
    initialPage: 'devices',
    homePage: 'games',
    context: pageContext,
    onRestore: (context) => {
      setGameId(context.gameId)
      setTaskProjectId(context.taskProjectId)
      setTaskCopyId(context.taskCopyId)
      setTaskRestoreId(context.taskRestoreId)
    },
  })
  const { page } = navigation
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
  const [isUpload, setIsUpload] = useState(false)
  const [portDraft, setPortDraft] = useState<number | null | undefined>(undefined)
  // 设备页开关按下后、服务快照刷新前显示“正在启动”或“正在停止”；run 结束时清空。
  const [serviceChange, setServiceChange] = useState<'starting' | 'stopping' | null>(null)
  const [copied, setCopied] = useState('')
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [interruptedWrites, setInterruptedWrites] = useState<readonly InterruptedWrite[]>([])
  const [dataResets, setDataResets] = useState<readonly DataResetItem[]>([])
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [isAddDeviceOpen, setIsAddDeviceOpen] = useState(false)
  const [addressDraft, setAddressDraft] = useState('')
  const [isPosterSearchOpen, setIsPosterSearchOpen] = useState(false)
  // 正在保存的搜索候选；只在 isBusy 时有效，run 结束后不必清空。
  const [posterSavingId, setPosterSavingId] = useState<string | null>(null)
  // 轮询要读到当前页面：只在设备页续期局域网搜索。
  const pageRef = useRef(page)
  useLayoutEffect(() => {
    pageRef.current = page
  }, [page])

  const operating = useRef(false)
  const generation = useRef(0)
  const invalidate = useCallback(() => {
    generation.current++
  }, [])
  // 只由 refresh 写入，和 snapshot state 同步更新。
  const snapshotRef = useRef(snapshot)
  // refresh 发现对方发起的传输时调用，要用到最新的导航和页面上下文。
  const openPeerTransfer = useRef<(projectId: string, jobId: string) => void>(() => undefined)
  const refresh = useCallback(async (): Promise<void> => {
    const version = ++generation.current
    const value = await adapter.read(pageRef.current === 'devices')
    if (version === generation.current) {
      const previous = snapshotRef.current
      // 打开应用时已有的任务不算刚开始，不切页面。
      // 不要求任务还在 running：短传输可能在两次轮询之间就结束，窗口最小化或被遮挡时
      // Chromium 还会把轮询拖到几十秒一次，第一次看到时任务常已结束。
      const started = previous
        ? value.copies.find(
            (item) =>
              item.isPeerInitiated && !previous.copies.some((old) => old.jobId === item.jobId),
          )
        : undefined
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
      if (started) {
        openPeerTransfer.current(started.projectId, started.jobId)
      }
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
  // 服务刚启动时还在读取本机地址（通常不到半秒）。这期间每 250 毫秒再读一次快照，
  // 不等 1.8 秒的常规轮询，地址读到后尽快显示。
  const isAddressLoading =
    Boolean(snapshot?.service?.listener) && snapshot?.service?.ipv4Addresses === null
  useEffect(() => {
    if (!isAddressLoading) {
      return
    }
    const timer = setTimeout(() => {
      refresh().catch((cause: unknown) => showError(toShownError(cause)))
    }, 250)
    return () => clearTimeout(timer)
  }, [isAddressLoading, snapshot, refresh, showError])
  // 传输结束时用 Message 提示一次结果；打开应用时已经结束的任务只在详情里看。
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
  useEffect(() => {
    let isCurrent = true
    desktopDataReset()
      .list()
      .then((result) => {
        if (isCurrent) {
          setDataResets(unwrap(result))
        }
      })
      .catch((cause: unknown) => showError(toShownError(cause)))
    return () => {
      isCurrent = false
    }
  }, [showError])
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
        setServiceChange(null)
      })
  }
  const config = snapshot?.config ?? EMPTY
  const posterUrls = usePosterUrls(config.games, POSTERS)
  const port = portDraft === undefined ? (snapshot?.service?.port ?? null) : portDraft
  const game = config.games.find((item) => item.id === gameId) ?? null
  // 离开设置页或游戏被删除时弹层跟着关闭。
  const isPosterSearchShown = isPosterSearchOpen && page === 'edit' && game !== null
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
  const hasRunningNetworkWork = Boolean(snapshot?.copies.some((task) => task.phase === 'running'))
  const hasRunningWork =
    hasRunningNetworkWork || Boolean(snapshot?.restores.some((task) => task.isWorking))
  const isDisabled = isBusy || !snapshot
  // 游戏移除后，它已结束的传输和恢复不再放进任务条，否则任务条留着一条名为“未知”的记录。
  const isStripShown = (projectId: string, isWorking: boolean): boolean =>
    isWorking || config.games.some((item) => item.id === projectId)
  const copiesByRecent = [...(snapshot?.copies ?? [])]
    .filter((item) => isStripShown(item.projectId, item.phase === 'running'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const copy = copiesByRecent.find((item) => item.phase === 'running') ?? copiesByRecent[0] ?? null
  const gameCopy = copiesByRecent.find((item) => item.projectId === game?.id) ?? null
  const restoresByRecent = [...(snapshot?.restores ?? [])]
    .filter((item) => isStripShown(item.projectId, item.isWorking))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const restore = restoresByRecent.find((item) => item.isWorking) ?? restoresByRecent[0] ?? null
  const copyPreview = copy ? syncTaskPreview(copy, t) : null
  const shouldShowCopy =
    copy &&
    (copy.phase === 'running' ||
      !restore ||
      (!restore.isWorking && copy.updatedAt >= restore.updatedAt))
  const stripProjectId = shouldShowCopy ? copy.projectId : (restore?.projectId ?? null)
  const stripTask: TaskStripInfo | null =
    shouldShowCopy && copyPreview
      ? {
          ...copyPreview,
          gameName:
            config.games.find((item) => item.id === copy.projectId)?.name ?? t('common.unknown'),
        }
      : restore
        ? {
            ...restoreObservationPreview(restore, t),
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
  async function savePoster(
    target: LibraryGame,
    image: PosterImageData,
    source: PosterOrigin,
  ): Promise<void> {
    let data: string
    try {
      data = await encodePosterImage(image)
    } catch (cause) {
      // 解码失败说明选的文件不是能识别的图片，换成能看懂的提示；其他失败照常显示。
      if (cause instanceof OperationFailure && cause.code === 'invalid-request') {
        throw new Error(t('poster.unreadable'), { cause })
      }
      throw cause
    }
    const posterHash = await POSTERS.save(target.id, data)
    await saveGame({ ...target, posterHash, posterSource: source })
    appMessage.show({ type: 'success', content: t('poster.saved'), slot: 'poster' })
  }
  function pickSearchedPoster(candidate: PosterImageCandidate): void {
    if (!game) {
      return
    }
    setPosterSavingId(candidate.id)
    run(async () => {
      await savePoster(game, await POSTERS.downloadImage(candidate.downloadUrl), candidate.source)
      setIsPosterSearchOpen(false)
    })
  }
  function pickLocalPoster(): void {
    if (!game) {
      return
    }
    run(async () => {
      const image = await POSTERS.pickImage()
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
            (gameId, data) => POSTERS.save(gameId, data),
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
    navigator.clipboard
      .writeText(formatConnectionAddress(address))
      .then(() => {
        appMessage.show({ type: 'success', content: t('common.copied'), slot: 'copy-address' })
        // 复制按钮显示对勾 2 秒后换回复制图标；连续复制时从最后一次重新计时。
        setCopied(address)
        clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(''), 2000)
      })
      .catch((cause: unknown) => showError(toShownError(cause)))
  }
  function toggleService(): void {
    const service = snapshot?.service
    if (!service) {
      return
    }
    const isRunning = service.listener !== null
    if (isRunning && hasRunningNetworkWork) {
      setConfirmation({
        title: t('service.stopTitle'),
        text: t('service.stopText'),
        work: async () => {
          await adapter.service(false, port ?? service.port)
          setConfirmation(null)
        },
      })
    } else {
      run(async () => {
        setServiceChange(isRunning ? 'stopping' : 'starting')
        await adapter.service(!isRunning, port ?? service.port)
      })
    }
  }
  function actOnDevice(peer: LibraryPeer): void {
    if (peer.isConnected || snapshot?.dialer.session?.deviceId === peer.device.id) {
      run(() => adapter.device(peer.device.id, 'disconnect'))
    }
  }
  /** 连接另一台设备；deviceId 是要连接的已保存或附近设备，手动输入地址时为 null。 */
  function connectDevice(deviceId: string | null, connect: () => Promise<DesktopDialResult>): void {
    run(async () => {
      setConnectingId(deviceId)
      try {
        const result = await connect()
        setIsAddDeviceOpen(false)
        appMessage.show({
          type: 'success',
          content: t(result.isRelocated ? 'device.relocated' : 'app.connectedTo', {
            name: result.name,
          }),
          slot: 'connection',
        })
      } catch (cause) {
        // 连接失败不中断 run：失败要带“连接失败”的上下文提示，之后照常刷新状态。
        showError(toShownError(cause), t('device.connectFailed'))
      } finally {
        setConnectingId(null)
      }
    })
  }
  function connectNearby(device: DesktopNearbyDevice): void {
    connectDevice(device.deviceId, () =>
      adapter.connect(
        device.addresses.map((address) => `${address}:${device.port}`),
        device.deviceId,
      ),
    )
  }
  function openAddDevice(): void {
    setAddressDraft('')
    setIsAddDeviceOpen(true)
  }
  function go(value: Page): void {
    setIsGameActionDialogOpen(false)
    navigation.open(value)
  }
  function showTask(
    projectId: string | null,
    copyId: string | null,
    restoreId: string | null,
  ): void {
    setTaskProjectId(projectId)
    setTaskCopyId(copyId)
    setTaskRestoreId(restoreId)
    setIsGameActionDialogOpen(false)
  }
  function openTasks(
    projectId: string | null,
    copyId: string | null,
    restoreId: string | null = null,
  ): void {
    showTask(projectId, copyId, restoreId)
    navigation.open('task')
  }
  // 对方发起的传输和本机发起的一样结束当前流程，详情返回游戏页。窗口最小化时也只切页面，不还原、不抢焦点。
  useLayoutEffect(() => {
    openPeerTransfer.current = (projectId, jobId) => {
      showTask(projectId, jobId, null)
      navigation.finishFlow('task')
    }
  })
  function openBackup(projectId: string, sourceContext?: PageContext): void {
    setGameId(projectId)
    navigation.open('backup', sourceContext)
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
  }
  function changeUpload(isNextUpload: boolean): void {
    setIsUpload(isNextUpload)
  }
  function unlinkGame(deviceId: string): void {
    if (!game) {
      return
    }
    run(() => saveGame(withoutGameLink(game, deviceId)))
  }
  /** 新关联或更换关联游戏；保存成功后 resolve，失败显示错误并 reject。 */
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
    setNewGameName(choice.item.name)
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
        navigation.openMain('games')
      },
    })
  }
  let body: React.ReactNode
  if (page === 'devices') {
    body = (
      <DevicesPage
        service={snapshot?.service ?? null}
        serviceChange={serviceChange}
        peers={peers}
        dialer={snapshot?.dialer ?? null}
        connectingId={connectingId}
        copied={copied}
        port={port}
        isBusy={isBusy}
        isDisabled={isDisabled}
        isActive={isActive}
        onPortChange={setPortDraft}
        onRandomizePort={() => run(async () => setPortDraft(await adapter.randomizePort()))}
        onToggleService={toggleService}
        onCopyAddress={copyAddress}
        onAddDevice={openAddDevice}
        onConnectSaved={(peer) =>
          connectDevice(peer.device.id, () => adapter.connectSaved(peer.device.id))
        }
        onConnectNearby={connectNearby}
        onDeviceAction={actOnDevice}
        onManageDevice={deviceEditor}
      />
    )
  } else if (page === 'games') {
    body = (
      <GamesPage
        games={config.games}
        posterUrls={posterUrls}
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
            shouldShowCopy ? copy.jobId : null,
            shouldShowCopy ? null : (restore?.restoreId ?? null),
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
        posterUrl={posterUrls.get(game.id) ?? null}
        coverIndex={config.games.indexOf(game)}
        isDisabled={isDisabled}
        isActive={isActive}
        onRename={renameGame}
        onChooseDirectory={chooseDirectory}
        onSearchPoster={() => setIsPosterSearchOpen(true)}
        onPickPoster={pickLocalPoster}
        onRemovePoster={removePoster}
        onLink={linkGame}
        onUnlink={unlinkGame}
        onTransfer={(deviceId) => {
          setPeerId(deviceId)
          navigation.open('transfer')
        }}
        onManageDevices={() => navigation.open('devices')}
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
        isLocalDialer={snapshot?.dialer.session?.deviceId === peerId}
        isUpload={isUpload}
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
            .finally(() => {
              // 开始传输结束本次流程：详情返回游戏页，不回比较或计划。
              showTask(game.id, null, null)
              navigation.finishFlow('task')
            })
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
        restoreSources={restoreSources}
        games={config.games}
        peers={peers}
        onChanged={tasksChanged}
        onOpenBackup={(projectId, shownCopyId, shownRestoreId) =>
          openBackup(projectId, {
            ...pageContext,
            taskCopyId: shownCopyId,
            taskRestoreId: shownRestoreId,
          })
        }
        onRescan={(projectId, deviceId, isRescanUpload, shownCopyId) => {
          setGameId(projectId)
          setPeerId(deviceId)
          setIsUpload(isRescanUpload)
          navigation.open('transfer', {
            ...pageContext,
            taskCopyId: shownCopyId,
            taskRestoreId: null,
          })
        }}
      />
    )
  } else if (page === 'backup') {
    body = (
      <BackupPage
        key={gameId}
        roots={snapshot?.roots ?? []}
        game={game}
        isActive={isActive}
        hasRunningWork={hasRunningWork}
        onOpenSettings={() => navigation.open('edit')}
        onOpenAppSettings={() => navigation.open('settings')}
        onRestoreStarted={(restoreId, sourceName) => {
          setRestoreSources((current) => ({ ...current, [restoreId]: sourceName }))
          refresh()
            .catch((cause: unknown) => showError(toShownError(cause)))
            .finally(() => {
              showTask(game?.id ?? null, null, restoreId)
              navigation.open('task')
            })
        }}
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
          transferBlocker={game ? gameTransferBlocker(game, peers) : 'no-link'}
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
      <AddDeviceDialog
        isOpen={isAddDeviceOpen}
        address={addressDraft}
        isBusy={isBusy}
        onAddressChange={setAddressDraft}
        onCancel={() => setIsAddDeviceOpen(false)}
        onConnect={() => connectDevice(null, () => adapter.connect([addressDraft.trim()], null))}
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
      <DataResetDialog
        items={dataResets}
        onOpenFolder={() => {
          desktopDataReset()
            .openFolder()
            .then(unwrap)
            .catch((cause: unknown) => showError(toShownError(cause)))
        }}
        onClose={() => {
          setDataResets([])
          desktopDataReset()
            .dismiss()
            .then(unwrap)
            .catch((cause: unknown) => showError(toShownError(cause)))
        }}
      />
      <PosterSearchModal
        open={isPosterSearchShown}
        gameName={game?.name ?? ''}
        adapter={POSTERS}
        savingId={isBusy ? posterSavingId : null}
        onPick={pickSearchedPoster}
        onClose={() => setIsPosterSearchOpen(false)}
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
    <DesktopShell
      theme={appPreferences.theme}
      page={page}
      title={t(PAGE_TITLE_KEYS[page])}
      gameName={game?.name ?? null}
      hasBack={navigation.backTarget !== null}
      headerAction={
        page === 'transfer' && game ? (
          <>
            <Tooltip title={t('page.gameSettings')}>
              <Button
                type="text"
                icon={<ControlOutlined />}
                aria-label={t('page.gameSettings')}
                onClick={() => navigation.open('edit')}
              />
            </Tooltip>
            <Tooltip title={t('page.backup')}>
              <Button
                type="text"
                icon={<HistoryOutlined />}
                aria-label={t('page.backup')}
                onClick={() => go('backup')}
              />
            </Tooltip>
          </>
        ) : null
      }
      dialogs={dialogs}
      onBack={() => navigation.back()}
      onNavigate={(target) => navigation.openMain(target)}
    >
      {body}
    </DesktopShell>
  )
}
