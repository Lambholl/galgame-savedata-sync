import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionSheet } from 'antd-mobile'
import { RightOutlined } from '@ant-design/icons'
import {
  compareSnapshots,
  isPreviewLocalSource,
  isSyncWriteEntry,
  syncPlanFromPreview,
  toShownError,
} from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  ShownError,
  SyncPreparationPreview,
  SyncPreparationState,
  SyncDirection,
} from '@savedata-sync/shared'
import { TransferComparison, syncStartConfirmation, useT } from '@savedata-sync/shared/ui'
import type { ComparisonStatus, PlanEndpoint } from '@savedata-sync/shared/ui'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import type { Confirmation } from '../../app/navigation-types'
import { FloatingAction } from '../../components/FloatingAction'
import { PlanConfirm } from './PlanConfirm'
import { ModifiedDateNotice } from './ModifiedDateNotice'

const POLL_INTERVAL_MS = 700

/**
 * 传输存档页和传输计划页：进入页面、翻转方向、切换设备或刷新时自动扫描两端，比较结果和计划来自同一份预览。
 * 离开页面或重新扫描时释放之前还没执行的准备。
 */
export function SyncCopyPage({
  sync,
  game,
  peers,
  localRoot,
  deviceName,
  peerId,
  isLocalListener,
  initialDirection,
  isPlan,
  isDisabled,
  isTransferActive,
  onPeerChange,
  onConfirm,
  onStarted,
  onPreview,
  onPlanExpired,
  onFailure,
}: {
  readonly sync: MobileSyncAdapter
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly localRoot: DirectoryReference | null
  readonly deviceName: string | null
  readonly peerId: string
  /** 所选设备连着本机服务，本机是监听方；否则本机是拨号方。 */
  readonly isLocalListener: boolean
  /** 页面打开时的传输方向，之后由页面里的翻转按钮改变；null 表示从所选设备复制到本机。 */
  readonly initialDirection: SyncDirection | null
  readonly isPlan: boolean
  readonly isDisabled: boolean
  /** 有传输或恢复在进行时不发起新的扫描。 */
  readonly isTransferActive: boolean
  readonly onPeerChange: (id: string) => void
  readonly onConfirm: (confirmation: Confirmation) => void
  /** 任务已开始；完成前开始按钮保持转圈。 */
  readonly onStarted: (jobId: string) => Promise<void>
  readonly onPreview: () => void
  /** 计划已过期，提示一次并从计划页回到比较页。 */
  readonly onPlanExpired: () => void
  readonly onFailure: (error: ShownError) => void
}): React.JSX.Element {
  const t = useT()
  // 方向按连接角色命名：复制到本机时由对方这一端指向本机这一端。
  const [direction, setDirection] = useState<SyncDirection>(
    initialDirection ?? (isLocalListener ? 'dialer-to-listener' : 'listener-to-dialer'),
  )
  // 换成角色不同的设备时保持复制到本机还是复制到对方不变。
  const [wasLocalListener, setWasLocalListener] = useState(isLocalListener)
  if (wasLocalListener !== isLocalListener) {
    setWasLocalListener(isLocalListener)
    setDirection(direction === 'listener-to-dialer' ? 'dialer-to-listener' : 'listener-to-dialer')
  }
  const localSide = isLocalListener ? 'listener' : 'dialer'
  const isLocalSource = isPreviewLocalSource({ direction, localSide })
  const [preparation, setPreparation] = useState<SyncPreparationState | null>(null)
  const [preview, setPreview] = useState<SyncPreparationPreview | null>(null)
  /** 扫描失败的原因；null 表示没有失败。 */
  const [scanError, setScanError] = useState<ShownError | null>(null)
  const [scanVersion, setScanVersion] = useState(0)
  const [isPeerSheetOpen, setIsPeerSheetOpen] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  /** 目标多出的条目是否保留；每次重新比较都回到保留，不记住上次的选择。 */
  const [isKeepingExtras, setIsKeepingExtras] = useState(true)
  const executed = useRef<string | null>(null)
  const peer = peers.find((item) => item.device.id === peerId)
  const remote = peer?.games.find(
    (item) => item.id === game.links.find((link) => link.deviceId === peerId)?.gameId,
  )
  const remoteRootId = remote?.root?.rootId ?? null
  const localRootId = localRoot?.rootId ?? null
  const isConnected = Boolean(peer?.isConnected)
  const isLocalRootLost = localRoot !== null && localRoot.authorization !== 'granted'
  const isRemoteRootLost = Boolean(remote?.root && remote.root.authorization !== 'granted')
  const canScan =
    isConnected &&
    localRootId !== null &&
    remoteRootId !== null &&
    !isLocalRootLost &&
    !isRemoteRootLost &&
    !isTransferActive
  // 每次重新比较前清掉上一次的结果和选择。
  const scanKey = canScan
    ? [game.id, peerId, direction, localRootId, remoteRootId, scanVersion].join('\n')
    : null
  const [startedScanKey, setStartedScanKey] = useState(scanKey)
  if (startedScanKey !== scanKey) {
    setStartedScanKey(scanKey)
    if (scanKey !== null) {
      setPreparation(null)
      setPreview(null)
      setScanError(null)
      setIsKeepingExtras(true)
    }
  }
  useEffect(() => {
    if (!canScan) {
      return
    }
    let isCurrent = true
    let id: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    async function accept(state: SyncPreparationState): Promise<void> {
      if (!isCurrent) {
        return
      }
      setPreparation(state)
      if (state.status === 'ready') {
        const value = await sync.preview(state.preparationId)
        if (isCurrent) {
          setPreview(value)
        }
      } else if (state.status === 'preparing') {
        timer = setTimeout(() => {
          sync.preparation(state.preparationId).then(accept).catch(fail)
        }, POLL_INTERVAL_MS)
      }
    }
    function fail(cause: unknown): void {
      if (isCurrent) {
        setScanError(toShownError(cause))
      }
    }
    sync
      .prepare(game.id, peerId, direction)
      .then((state) => {
        // 原生层返回前已离开或开始了新扫描，清理时还不知道 ID。
        if (!isCurrent) {
          return sync.releasePreparation(state.preparationId).catch(() => undefined)
        }
        id = state.preparationId
        return accept(state)
      })
      .catch(fail)
    return () => {
      isCurrent = false
      clearTimeout(timer)
      if (id !== null && id !== executed.current) {
        sync.releasePreparation(id).catch(() => undefined)
      }
    }
  }, [canScan, sync, game.id, peerId, direction, localRootId, remoteRootId, scanVersion])
  const comparison = useMemo(() => {
    if (!preview) {
      return null
    }
    const isListenerSource = preview.direction === 'listener-to-dialer'
    return isListenerSource
      ? compareSnapshots(preview.source, preview.target)
      : compareSnapshots(preview.target, preview.source)
  }, [preview])
  const plan = useMemo(
    () =>
      preview ? syncPlanFromPreview({ ...preview, shouldDeleteExtras: !isKeepingExtras }) : null,
    [preview, isKeepingExtras],
  )
  const hasExtras =
    plan?.entries.some(
      (item) =>
        item.action === 'keep' ||
        item.action === 'delete-file' ||
        item.action === 'delete-directory',
    ) ?? false
  const hasChanged =
    preview !== null &&
    (preview.direction !== direction ||
      preview.binding.projectId !== game.id ||
      preview.binding.remoteDeviceId !== peerId ||
      preview.binding.localRootId !== localRootId ||
      preview.binding.remoteRootId !== remoteRootId ||
      preview.binding.remoteProjectId !== remote?.id)
  let status: ComparisonStatus
  if (!peer) {
    status = {
      kind: 'unavailable',
      reason: t(game.links.length > 0 ? 'transfer.pickPeerTitle' : 'transfer.noPeer'),
    }
  } else if (!isConnected) {
    status = { kind: 'unavailable', reason: t('transfer.peerOffline', { name: peer.device.name }) }
  } else if (localRootId === null) {
    status = { kind: 'unavailable', reason: t('transfer.noLocalRoot') }
  } else if (remoteRootId === null) {
    status = { kind: 'unavailable', reason: t('transfer.noRemoteRoot') }
  } else if (isLocalRootLost) {
    status = { kind: 'unavailable', reason: t('transfer.localRootLost') }
  } else if (isRemoteRootLost) {
    status = {
      kind: 'unavailable',
      reason: t('transfer.remoteRootLost', { name: peer.device.name }),
    }
  } else if (scanError !== null || preparation?.status === 'failed') {
    status = { kind: 'failed', error: scanError ?? preparation?.error ?? null }
  } else if (preparation?.status === 'cancelled') {
    status = { kind: 'cancelled' }
  } else if (comparison && !hasChanged) {
    status = { kind: 'ready', comparison }
  } else {
    status = { kind: 'scanning' }
  }
  /** 扫描已开始、还没出结果时可以取消；取消后由刷新重新扫描。 */
  const cancellableId =
    status.kind === 'scanning' && preparation?.status === 'preparing'
      ? preparation.preparationId
      : null
  function cancelScan(id: string): void {
    sync
      .cancelPreparation(id)
      // 期间若已开始新的扫描，保留新扫描的状态。
      .then((state) =>
        setPreparation((current) =>
          current?.preparationId === state.preparationId ? state : current,
        ),
      )
      .catch((cause: unknown) => setScanError(toShownError(cause)))
  }
  const hasChanges = plan?.entries.some(isSyncWriteEntry) ?? false
  const canStart = !hasChanged && Boolean(plan?.canExecute) && hasChanges
  function start(): void {
    if (!plan || !preparation || !canStart) {
      return
    }
    const id = preparation.preparationId
    const shouldDeleteExtras = plan.shouldDeleteExtras
    async function work(): Promise<void> {
      executed.current = id
      try {
        const state = await sync.execute(id, shouldDeleteExtras)
        await onStarted(state.jobId)
      } catch (cause) {
        executed.current = null
        // 这份计划不能再用：回到比较页重新扫描，用户确认新结果后再开始。
        if (toShownError(cause).code !== 'plan-expired') {
          throw cause
        }
        onPlanExpired()
        setScanVersion((value) => value + 1)
      }
    }
    const confirmation = syncStartConfirmation(plan, t)
    if (confirmation) {
      onConfirm({ ...confirmation, okType: 'danger', work })
      return
    }
    setIsStarting(true)
    work()
      .catch((cause: unknown) => onFailure(toShownError(cause)))
      .finally(() => setIsStarting(false))
  }
  const remoteName =
    peer?.device.name ?? t(game.links.length > 0 ? 'transfer.pickPeerTitle' : 'common.unknown')
  const remotePlatform = peer?.device.platform ?? 'windows'
  const localEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'mobile' }
  const remoteEnd: PlanEndpoint = {
    name: remoteName,
    kind: remotePlatform === 'android' ? 'mobile' : 'pc',
  }
  const remoteDevice = {
    name: remoteName,
    caption: '',
    isOnline: peer ? isConnected : null,
    rootName: remote?.root?.displayName ?? '—',
    platform: remotePlatform,
  }
  const localDevice = {
    name: t('transfer.local'),
    caption: deviceName ?? '',
    isOnline: null,
    rootName: localRoot?.displayName ?? '—',
    platform: 'android' as const,
  }
  return (
    <>
      {/* 打开计划时只隐藏比较区，返回后文件夹位置和筛选保持不变。 */}
      <div className="transfer-fill" hidden={isPlan}>
        <TransferComparison
          key={peerId}
          listener={isLocalListener ? localDevice : remoteDevice}
          dialer={isLocalListener ? remoteDevice : localDevice}
          remoteSide={isLocalListener ? 'dialer' : 'listener'}
          direction={direction}
          status={status}
          isLocked={isDisabled || isStarting}
          onFlip={() =>
            setDirection(
              direction === 'listener-to-dialer' ? 'dialer-to-listener' : 'listener-to-dialer',
            )
          }
          onPickPeer={() => setIsPeerSheetOpen(true)}
          onRefresh={() => setScanVersion((value) => value + 1)}
          onCancel={cancellableId === null ? null : () => cancelScan(cancellableId)}
          isKeepingExtras={isKeepingExtras}
          onKeepExtrasChange={hasExtras ? setIsKeepingExtras : null}
        />
      </div>
      {isPlan && plan ? (
        <PlanConfirm
          plan={plan}
          source={isLocalSource ? localEnd : remoteEnd}
          target={isLocalSource ? remoteEnd : localEnd}
          notice={
            <>
              {hasChanged ? <p className="notice notice-error">{t('transfer.planStale')}</p> : null}
              {isLocalSource ? null : <ModifiedDateNotice plan={plan} />}
            </>
          }
          action={{
            label: t('transfer.start'),
            isDisabled: isDisabled || !canStart,
            isLoading: isStarting,
            onClick: start,
          }}
        />
      ) : null}
      {isPlan && !plan ? <p className="notice">{t('transfer.planUnavailable')}</p> : null}
      <ActionSheet
        visible={isPeerSheetOpen}
        extra={t('transfer.pickPeerTitle')}
        cancelText={t('common.cancel')}
        actions={game.links.map((link) => {
          const device = peers.find((item) => item.device.id === link.deviceId)
          return {
            key: link.deviceId,
            text: device?.device.name ?? t('common.unknown'),
            description: t(device?.isConnected ? 'transfer.connected' : 'transfer.disconnected'),
            bold: link.deviceId === peerId,
          }
        })}
        onAction={(action) => {
          setIsPeerSheetOpen(false)
          onPeerChange(String(action.key))
        }}
        onClose={() => setIsPeerSheetOpen(false)}
      />
      {!isPlan && (
        <FloatingAction
          color="primary"
          icon={<RightOutlined />}
          iconPlacement="end"
          label={t('transfer.preview')}
          isDisabled={isDisabled || status.kind !== 'ready' || !plan}
          isLoading={false}
          onClick={onPreview}
        />
      )}
    </>
  )
}
