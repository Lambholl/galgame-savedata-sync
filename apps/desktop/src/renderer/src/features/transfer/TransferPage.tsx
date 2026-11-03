import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal } from 'antd'
import { CaretRightOutlined, RightOutlined } from '@ant-design/icons'
import { compareSnapshots, toShownError, unwrap } from '@savedata-sync/shared'
import type {
  CatalogGame,
  DirectoryReference,
  LibraryGame,
  LibraryPeer,
  ShownError,
  SyncPlan,
  TransferDirection,
} from '@savedata-sync/shared'
import { SyncPlanSummary, TransferComparison, useT } from '@savedata-sync/shared/ui'
import type { ComparisonStatus, PlanEndpoint } from '@savedata-sync/shared/ui'
import type { DesktopRemoteRequest } from '../../../../bridge/sync-bridge.ts'
import type { Confirmation } from '../../app/navigation.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { PlanDrawer } from './PlanDrawer.tsx'

const POLL_INTERVAL_MS = 400
const SCANNING: readonly DesktopRemoteRequest['status'][] = ['waiting', 'preparing']
const UNCONFIRMED: readonly DesktopRemoteRequest['status'][] = ['waiting', 'preparing', 'ready']

/**
 * 电脑传输页：进入即请求手机扫描两端，比较结果与计划来自手机返回的同一份计划；
 * 翻转方向、切换设备或刷新时取代旧请求，离开页面时取消未确认的请求。
 */
export function TransferPage({
  game,
  peers,
  selectedPeer,
  remoteGame,
  localRoot,
  deviceName,
  peerId,
  upload,
  isDisabled,
  isActive,
  onPeerChange,
  onUploadChange,
  onConfirm,
  onStarted,
}: {
  readonly game: LibraryGame
  readonly peers: readonly LibraryPeer[]
  readonly selectedPeer: LibraryPeer | null
  readonly remoteGame: CatalogGame | undefined
  readonly localRoot: DirectoryReference | null
  readonly deviceName: string | null
  readonly peerId: string
  readonly upload: boolean
  readonly isDisabled: boolean
  readonly isActive: boolean
  readonly onPeerChange: (id: string) => void
  readonly onUploadChange: (isUpload: boolean) => void
  readonly onConfirm: (confirmation: Confirmation) => void
  /** 手机已接受计划，转到传输详情。 */
  readonly onStarted: () => void
}): React.JSX.Element {
  const t = useT()
  const direction: TransferDirection = upload ? 'android-to-windows' : 'windows-to-android'
  const [request, setRequest] = useState<DesktopRemoteRequest | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ readonly requestId: string; readonly value: SyncPlan } | null>(
    null,
  )
  const [scanError, setScanError] = useState<ShownError | null>(null)
  const [scanVersion, setScanVersion] = useState(0)
  const [isPeerPickerOpen, setIsPeerPickerOpen] = useState(false)
  const [isPlanOpen, setIsPlanOpen] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const latest = useRef<DesktopRemoteRequest | null>(null)
  latest.current = request
  const localRootId = localRoot?.rootId ?? null
  const remoteRootId = remoteGame?.root?.rootId ?? null
  const isConnected = Boolean(selectedPeer?.isConnected)
  const isLocalRootLost = localRoot !== null && localRoot.authorization !== 'granted'
  const isRemoteRootLost = Boolean(remoteGame?.root && remoteGame.root.authorization !== 'granted')
  const canScan =
    isConnected &&
    localRootId !== null &&
    remoteRootId !== null &&
    !isLocalRootLost &&
    !isRemoteRootLost &&
    !isActive
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll(): Promise<void> {
      try {
        const value = unwrap(await desktopSync().remoteRequest())
        if (isCurrent) {
          setRequest(value)
        }
      } catch {
        // 读取失败时保留上次状态，下一轮再试。
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch(() => undefined)
        }, POLL_INTERVAL_MS)
      }
    }
    poll().catch(() => undefined)
    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (!canScan) {
      return
    }
    let isCurrent = true
    let id: string | null = null
    setRequestId(null)
    setScanError(null)
    setIsPlanOpen(false)
    desktopSync()
      .startRemote(game.id, peerId, direction)
      .then((result) => {
        const value = unwrap(result)
        id = value.requestId
        if (isCurrent) {
          setRequest(value)
          setRequestId(value.requestId)
        } else {
          desktopSync()
            .cancelRemote(value.requestId)
            .catch(() => undefined)
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setScanError(toShownError(cause))
        }
      })
    return () => {
      isCurrent = false
      const current = latest.current
      if (id !== null && (current?.requestId !== id || UNCONFIRMED.includes(current.status))) {
        desktopSync()
          .cancelRemote(id)
          .catch(() => undefined)
      }
    }
  }, [canScan, game.id, peerId, direction, localRootId, remoteRootId, scanVersion])
  const shown = request !== null && request.requestId === requestId ? request : null
  const hasPlan = shown?.status === 'ready'
  useEffect(() => {
    if (!requestId || !hasPlan || plan?.requestId === requestId) {
      return
    }
    let isCurrent = true
    desktopSync()
      .remotePlan(requestId)
      .then((result) => {
        if (isCurrent) {
          setPlan({ requestId, value: unwrap(result) })
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setScanError(toShownError(cause))
        }
      })
    return () => {
      isCurrent = false
    }
  }, [requestId, hasPlan, plan?.requestId])
  const current = shown && plan?.requestId === shown.requestId ? plan.value : null
  const comparison = useMemo(() => {
    if (!current) {
      return null
    }
    return current.direction === 'windows-to-android'
      ? compareSnapshots(current.source, current.target)
      : compareSnapshots(current.target, current.source)
  }, [current])
  const isOtherConfirmed =
    request !== null && request.requestId !== requestId && request.status === 'starting'
  let status: ComparisonStatus
  if (!selectedPeer) {
    status = {
      kind: 'unavailable',
      reason: t(game.links.length > 0 ? 'transfer.pickPeerTitle' : 'transfer.noPeer'),
    }
  } else if (!isConnected) {
    status = {
      kind: 'unavailable',
      reason: t('transfer.peerOffline', { name: selectedPeer.device.name }),
    }
  } else if (localRootId === null) {
    status = { kind: 'unavailable', reason: t('transfer.noLocalRoot') }
  } else if (remoteRootId === null) {
    status = { kind: 'unavailable', reason: t('transfer.noRemoteRoot') }
  } else if (isLocalRootLost) {
    status = { kind: 'unavailable', reason: t('transfer.localRootLost') }
  } else if (isRemoteRootLost) {
    status = {
      kind: 'unavailable',
      reason: t('transfer.remoteRootLost', { name: selectedPeer.device.name }),
    }
  } else if (scanError !== null || shown?.status === 'failed') {
    status = { kind: 'failed', error: scanError ?? shown?.error ?? null }
  } else if (shown?.status === 'cancelled') {
    status = { kind: 'cancelled' }
  } else if (comparison) {
    status = { kind: 'ready', comparison }
  } else if (isOtherConfirmed) {
    status = { kind: 'unavailable', reason: t('transfer.remoteBusy') }
  } else if (shown === null || shown.status === 'waiting') {
    // 请求还没登记或手机还没响应。
    status = { kind: 'waiting' }
  } else {
    status = { kind: 'scanning' }
  }
  const hasChanges =
    current?.entries.some((item) =>
      ['create-file', 'replace-file', 'create-directory'].includes(item.action),
    ) ?? false
  const canStart = shown?.status === 'ready' && Boolean(current?.canExecute) && hasChanges
  const peerName =
    selectedPeer?.device.name ??
    t(game.links.length > 0 ? 'transfer.pickPeerTitle' : 'common.unknown')
  const localName = t('transfer.local')
  const pcEnd: PlanEndpoint = { name: localName, kind: 'pc' }
  const phoneEnd: PlanEndpoint = { name: peerName, kind: 'phone' }
  function start(): void {
    if (!shown || !current || !canStart) {
      return
    }
    const id = shown.requestId
    async function work(): Promise<void> {
      setRequest(unwrap(await desktopSync().confirmRemote(id)))
      onStarted()
    }
    // 开启备份时直接开始；关闭备份时才确认一次。
    if (!current.shouldBackup) {
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
      .catch((cause: unknown) => setScanError(toShownError(cause)))
      .finally(() => setIsStarting(false))
  }
  const isScanning = shown !== null && SCANNING.includes(shown.status)
  return (
    <div className="transfer-page">
      <TransferComparison
        key={peerId}
        pc={{
          name: localName,
          caption: deviceName ?? '',
          isOnline: null,
          rootName: localRoot?.displayName ?? '—',
        }}
        phone={{
          name: peerName,
          caption: '',
          isOnline: selectedPeer ? isConnected : null,
          rootName: remoteGame?.root?.displayName ?? '—',
        }}
        remoteSide="phone"
        direction={direction}
        status={status}
        isLocked={isDisabled || isActive || isStarting}
        onFlip={() => onUploadChange(!upload)}
        onPickPeer={() => setIsPeerPickerOpen(true)}
        onRefresh={() => setScanVersion((value) => value + 1)}
        onCancel={
          isScanning && shown
            ? () => {
                desktopSync()
                  .cancelRemote(shown.requestId)
                  .then((result) => setRequest(unwrap(result)))
                  .catch((cause: unknown) => setScanError(toShownError(cause)))
              }
            : null
        }
      />
      {/* 底部只有一个悬浮的下一步按钮；文件列末尾留出它的高度。 */}
      <Button
        className="transfer-next"
        type="primary"
        size="large"
        icon={<RightOutlined />}
        iconPlacement="end"
        disabled={isDisabled || status.kind !== 'ready' || !current}
        onClick={() => setIsPlanOpen(true)}
      >
        {t('transfer.preview')}
      </Button>
      <PlanDrawer
        isOpen={isPlanOpen && current !== null}
        title={t('page.plan')}
        gameName={game.name}
        action={{
          label: t('transfer.start'),
          icon: <CaretRightOutlined />,
          isDanger: false,
          isLoading: isStarting,
          isDisabled: isDisabled || !canStart,
          onClick: start,
        }}
        onClose={() => setIsPlanOpen(false)}
      >
        {current && (
          <SyncPlanSummary
            plan={current}
            source={upload ? phoneEnd : pcEnd}
            target={upload ? pcEnd : phoneEnd}
            backupKeepCount={shown?.backupKeepCount ?? null}
          />
        )}
      </PlanDrawer>
      <Modal
        open={isPeerPickerOpen}
        width={360}
        footer={null}
        title={t('transfer.pickPeerTitle')}
        onCancel={() => setIsPeerPickerOpen(false)}
      >
        <div className="transfer-peer-list">
          {game.links.map((link) => {
            const peer = peers.find((item) => item.device.id === link.deviceId)
            return (
              <Button
                key={link.deviceId}
                block
                type={link.deviceId === peerId ? 'primary' : 'default'}
                onClick={() => {
                  setIsPeerPickerOpen(false)
                  onPeerChange(link.deviceId)
                }}
              >
                {peer?.device.name ?? t('common.unknown')}
                <small>
                  {t(peer?.isConnected ? 'transfer.connected' : 'transfer.disconnected')}
                </small>
              </Button>
            )
          })}
        </div>
      </Modal>
    </div>
  )
}
