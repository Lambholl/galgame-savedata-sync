import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionSheet } from 'antd-mobile'
import { RightOutlined } from '@ant-design/icons'
import { compareSnapshots, syncPlanFromPreview, toShownError } from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  ShownError,
  SyncPreparationPreview,
  SyncPreparationState,
  TransferDirection,
} from '@savedata-sync/shared'
import { TransferComparison, useT } from '@savedata-sync/shared/ui'
import type { ComparisonStatus, PlanEndpoint } from '@savedata-sync/shared/ui'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import type { Confirmation } from '../../app/navigation-types'
import { FloatingAction } from '../../components/FloatingAction'
import { PlanConfirm } from './PlanConfirm'

const POLL_INTERVAL_MS = 700

/**
 * 传输存档与传输计划共用一次准备：进入页面、翻转方向、切换设备或刷新时自动扫描两端，
 * 比较结果与计划来自同一份预览；离开页面或重新扫描时释放旧准备，已执行的准备交给原生任务。
 */
export function SyncCopyPage({
  sync,
  game,
  peers,
  localRoot,
  deviceName,
  peerId,
  isPlan,
  isDisabled,
  isTransferActive,
  onPeerChange,
  onConfirm,
  onStarted,
  onPreview,
  onFailure,
}: {
  readonly sync: MobileSyncAdapter
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly localRoot: DirectoryReference | null
  readonly deviceName: string | null
  readonly peerId: string
  readonly isPlan: boolean
  readonly isDisabled: boolean
  /** 有传输或恢复在进行时不发起新的扫描。 */
  readonly isTransferActive: boolean
  readonly onPeerChange: (id: string) => void
  readonly onConfirm: (confirmation: Confirmation) => void
  readonly onStarted: (jobId: string) => void
  readonly onPreview: () => void
  readonly onFailure: (error: ShownError) => void
}): React.JSX.Element {
  const t = useT()
  const [direction, setDirection] = useState<TransferDirection>('windows-to-android')
  const [preparation, setPreparation] = useState<SyncPreparationState | null>(null)
  const [preview, setPreview] = useState<SyncPreparationPreview | null>(null)
  /** 扫描失败的原因；null 表示没有失败。 */
  const [scanError, setScanError] = useState<ShownError | null>(null)
  const [scanVersion, setScanVersion] = useState(0)
  const [isPeerSheetOpen, setIsPeerSheetOpen] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
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
  useEffect(() => {
    if (!canScan) {
      return
    }
    let isCurrent = true
    let id: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    setPreparation(null)
    setPreview(null)
    setScanError(null)
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
    const isPcSource = preview.direction === 'windows-to-android'
    return isPcSource
      ? compareSnapshots(preview.source, preview.target)
      : compareSnapshots(preview.target, preview.source)
  }, [preview])
  const plan = useMemo(() => (preview ? syncPlanFromPreview(preview) : null), [preview])
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
  const hasChanges =
    plan?.entries.some((item) =>
      ['create-file', 'replace-file', 'create-directory'].includes(item.action),
    ) ?? false
  const canStart = !hasChanged && Boolean(plan?.canExecute) && hasChanges
  function start(): void {
    if (!plan || !preparation || !canStart) {
      return
    }
    const id = preparation.preparationId
    async function work(): Promise<void> {
      executed.current = id
      try {
        const state = await sync.execute(id)
        onStarted(state.jobId)
      } catch (cause) {
        executed.current = null
        throw cause
      }
    }
    // 开启备份时直接开始；关闭备份时才确认一次。
    if (!plan.shouldBackup) {
      onConfirm({
        title: t('transfer.noBackupTitle'),
        text: t('transfer.noBackupText'),
        okType: 'danger',
        work,
      })
      return
    }
    setIsStarting(true)
    work()
      .catch((cause: unknown) => onFailure(toShownError(cause)))
      .finally(() => setIsStarting(false))
  }
  const remoteName =
    peer?.device.name ?? t(game.links.length > 0 ? 'transfer.pickPeerTitle' : 'common.unknown')
  const localEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'phone' }
  const remoteEnd: PlanEndpoint = { name: remoteName, kind: 'pc' }
  return (
    <>
      {/* 打开计划时只隐藏比较区，返回后文件夹位置和筛选保持不变。 */}
      <div className="transfer-fill" hidden={isPlan}>
        <TransferComparison
          key={peerId}
          pc={{
            name: remoteName,
            caption: '',
            isOnline: peer ? isConnected : null,
            rootName: remote?.root?.displayName ?? '—',
          }}
          phone={{
            name: t('transfer.local'),
            caption: deviceName ?? '',
            isOnline: null,
            rootName: localRoot?.displayName ?? '—',
          }}
          remoteSide="pc"
          direction={direction}
          status={status}
          isLocked={isDisabled || isStarting}
          onFlip={() =>
            setDirection(
              direction === 'windows-to-android' ? 'android-to-windows' : 'windows-to-android',
            )
          }
          onPickPeer={() => setIsPeerSheetOpen(true)}
          onRefresh={() => setScanVersion((value) => value + 1)}
          onCancel={cancellableId === null ? null : () => cancelScan(cancellableId)}
        />
      </div>
      {isPlan && plan && (
        <PlanConfirm
          plan={plan}
          source={direction === 'android-to-windows' ? localEnd : remoteEnd}
          target={direction === 'android-to-windows' ? remoteEnd : localEnd}
          backupKeepCount={preview?.backupKeepCount ?? null}
          notice={hasChanged && <p className="notice notice-error">{t('transfer.planStale')}</p>}
          action={{
            label: t('transfer.start'),
            isDisabled: isDisabled || !canStart,
            isLoading: isStarting,
            onClick: start,
          }}
        />
      )}
      {isPlan && !plan && <p className="notice">{t('transfer.planUnavailable')}</p>}
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
