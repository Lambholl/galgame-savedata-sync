import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionSheet } from 'antd-mobile'
import { CaretRightOutlined, RightOutlined } from '@ant-design/icons'
import {
  compareSnapshots,
  resolveBackupPolicy,
  syncPlanFromPreview,
  toShownError,
} from '@savedata-sync/shared'
import type {
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  ShownError,
  SyncBackupSettings,
  SyncPreparationPreview,
  SyncPreparationState,
  TransferDirection,
} from '@savedata-sync/shared'
import { ErrorText, SyncPlanSummary, TransferComparison, useT } from '@savedata-sync/shared/ui'
import type { ComparisonStatus, PlanEndpoint } from '@savedata-sync/shared/ui'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import type { Confirmation } from '../../app/navigation-types'
import { BottomAction } from '../../components/BottomAction'

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
  const canScan = isConnected && localRootId !== null && remoteRootId !== null && !isTransferActive
  const [backupSettings, setBackupSettings] = useState<SyncBackupSettings | null>(null)
  useEffect(() => {
    let isCurrent = true
    sync
      .backupSettings()
      .then((value) => {
        if (isCurrent) {
          setBackupSettings(value)
        }
      })
      .catch(() => {
        // 读不到时计划只说明会备份，不显示份数。
      })
    return () => {
      isCurrent = false
    }
  }, [sync])
  /** 本机被写入时显示本机保留的份数；电脑的份数在这里读不到。 */
  const backupKeepCount =
    direction === 'windows-to-android' && backupSettings && localRootId !== null
      ? resolveBackupPolicy(backupSettings, game.id, localRootId).keepCount
      : null
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
    status = { kind: 'unavailable', message: t('transfer.noPeer') }
  } else if (!isConnected) {
    status = { kind: 'unavailable', message: t('transfer.peerOffline', { name: peer.device.name }) }
  } else if (localRootId === null) {
    status = { kind: 'unavailable', message: t('transfer.noLocalRoot') }
  } else if (remoteRootId === null) {
    status = { kind: 'unavailable', message: t('transfer.noRemoteRoot') }
  } else if (scanError !== null || preparation?.status === 'failed') {
    const reason = scanError ?? preparation?.error ?? null
    status = {
      kind: 'unavailable',
      message: reason ? (
        <ErrorText error={reason} context={t('transfer.compareFailed')} />
      ) : (
        t('transfer.compareFailed')
      ),
    }
  } else if (preparation?.status === 'cancelled') {
    status = { kind: 'unavailable', message: t('transfer.compareCancelled') }
  } else if (comparison && !hasChanged) {
    status = { kind: 'ready', comparison }
  } else {
    status = { kind: 'comparing' }
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
  const remoteName = peer?.device.name ?? t('common.unknown')
  const localEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'phone' }
  const remoteEnd: PlanEndpoint = { name: remoteName, kind: 'pc' }
  return (
    <>
      {!isPlan && (
        <TransferComparison
          key={`${peerId}/${direction}`}
          pc={{
            name: remoteName,
            caption: '',
            isOnline: peer ? isConnected : null,
            rootName: remote?.root?.displayName ?? '—',
          }}
          phone={{
            name: t('transfer.local'),
            caption: '',
            isOnline: null,
            rootName: localRoot?.displayName ?? '—',
          }}
          remoteSide="pc"
          direction={direction}
          status={status}
          layout="compact"
          isLocked={isDisabled || isStarting}
          onFlip={() =>
            setDirection(
              direction === 'windows-to-android' ? 'android-to-windows' : 'windows-to-android',
            )
          }
          onPickPeer={() => setIsPeerSheetOpen(true)}
          onRefresh={() => setScanVersion((value) => value + 1)}
        />
      )}
      {isPlan && plan && (
        <>
          {hasChanged && <p className="notice notice-error">{t('transfer.planStale')}</p>}
          <SyncPlanSummary
            key={plan.planId}
            plan={plan}
            source={direction === 'android-to-windows' ? localEnd : remoteEnd}
            target={direction === 'android-to-windows' ? remoteEnd : localEnd}
            backupKeepCount={backupKeepCount}
          />
        </>
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
      {isPlan ? (
        <BottomAction
          note={t('transfer.startNote')}
          icon={<CaretRightOutlined />}
          label={t('transfer.start')}
          isDisabled={isDisabled || !canStart}
          isLoading={isStarting}
          onClick={start}
        />
      ) : (
        <BottomAction
          note={null}
          icon={<RightOutlined />}
          label={status.kind === 'comparing' ? t('transfer.comparing') : t('transfer.preview')}
          isDisabled={isDisabled || status.kind !== 'ready' || !plan}
          isLoading={status.kind === 'comparing'}
          onClick={onPreview}
        />
      )}
    </>
  )
}
