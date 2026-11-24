import { useEffect, useState } from 'react'
import { Button } from 'antd-mobile'
import {
  HistoryOutlined,
  ReloadOutlined,
  RightOutlined,
  StopOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import {
  isPreviewLocalSource,
  observeRestoreTask,
  observeSyncJob,
  toShownError,
} from '@savedata-sync/shared'
import type { LibraryGame, LibraryPeer, ShownError, SyncDirection } from '@savedata-sync/shared'
import {
  RestoreSummary,
  SyncTaskSummary,
  restoreObservationPreview,
  syncTaskPreview,
  useT,
} from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message'
import type { PlanEndpoint } from '@savedata-sync/shared/ui'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'
import { FloatingAction } from '../../components/FloatingAction'
import { TechnicalDetails } from './TechnicalDetails'
import { ModifiedDateNotice } from './ModifiedDateNotice'

/**
 * 传输与恢复详情页：复制任务与本机恢复任务共用同一套布局、进度环、步骤条、结果列表与技术详情。
 * 进行中时可以取消任务，结束后可重新扫描或跳回备份页。
 */
export function SyncTaskDetails({
  projectId,
  initialKind,
  sync,
  copy,
  isLoading,
  restore,
  restoreSourceName,
  games,
  peers,
  errors,
  peerInitiatedJobIds,
  onChanged,
  onRescan,
  onBackup,
}: {
  readonly projectId: string | null
  /** 打开页面时优先展示复制还是恢复；null 时自动按进行中优先。 */
  readonly initialKind: 'copy' | 'restore' | null
  readonly sync: MobileSyncAdapter
  readonly copy: MobileCopyDetails | null
  /** 这款游戏的记录还没读到，此时不能说它没有记录。 */
  readonly isLoading: boolean
  readonly restore: MobileRestoreDetails | null
  /** 恢复任务来源备份的显示名；未知时为 null。 */
  readonly restoreSourceName: string | null
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly errors: readonly ShownError[]
  /** 本次运行期间由对方设备发起的任务 ID。 */
  readonly peerInitiatedJobIds: ReadonlySet<string>
  readonly onChanged: () => void
  /** 用这次传输的游戏、设备和方向重新比较。 */
  readonly onRescan: (projectId: string, deviceId: string, direction: SyncDirection) => void
  readonly onBackup: (projectId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [selectedKind, setSelectedKind] = useState<'copy' | 'restore' | null>(initialKind)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)
  function act(work: () => Promise<unknown>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError(null)
    work()
      .then(onChanged)
      .catch((cause: unknown) => {
        setError(toShownError(cause))
        onChanged()
      })
      .finally(() => setIsBusy(false))
  }

  const startedRestore =
    restore && restore.state.status !== 'preparing' && restore.state.status !== 'ready'
      ? restore
      : null
  const copyState = copy?.state ?? null
  const binding = copy?.preview.binding ?? null
  const isCopyRunning =
    copyState !== null &&
    observeSyncJob(copyState.local, copyState.remote, copyState.remoteError !== null).phase ===
      'running'
  const restoreObservation = startedRestore
    ? observeRestoreTask({
        ...startedRestore.state,
        cleanupError: startedRestore.state.result?.cleanupError ?? null,
      })
    : null
  const isRestoreRunning = restoreObservation?.phase === 'running'

  const shownKind: 'copy' | 'restore' | null =
    selectedKind === 'restore' && startedRestore
      ? 'restore'
      : selectedKind === 'copy' && copy
        ? 'copy'
        : isRestoreRunning && !isCopyRunning
          ? 'restore'
          : copy
            ? 'copy'
            : startedRestore
              ? 'restore'
              : null

  const copyGame = games.find((item) => item.id === binding?.projectId)
  const restoreGame = games.find((item) => item.id === startedRestore?.state.projectId)
  const peer = peers.find((item) => item.device.id === binding?.remoteDeviceId)
  const localEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'mobile' }
  const remoteEnd: PlanEndpoint = {
    name: peer?.device.name ?? t('common.unknown'),
    kind: peer?.device.platform === 'android' ? 'mobile' : 'pc',
  }
  const isLocalSource = copy ? isPreviewLocalSource(copy.preview) : false
  const failure = error ?? errors[0] ?? null
  // 失败用 Message 提示一次；读不到任务时正文留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(failure, failure ? t(error ? 'app.actionFailed' : 'task.readFailed') : null)
  }, [failure, error, showFailure, t])

  const copySwitchStatus =
    copy !== null
      ? syncTaskPreview(
          {
            ...observeSyncJob(copy.state.local, copy.state.remote, copy.state.remoteError !== null),
            shouldBackup: copy.plan.shouldBackup,
          },
          t,
        ).status
      : null
  const restoreSwitchStatus = restoreObservation
    ? restoreObservationPreview(restoreObservation, t).status
    : null

  return (
    <div className="page-stack">
      {failureHolder}
      {!copy && !startedRestore && failure ? (
        <div className="empty-state">
          <p>{t('task.readFailed')}</p>
          <Button
            size="small"
            disabled={isBusy}
            onClick={() =>
              act(() => (projectId ? sync.latestCopy(projectId, true) : sync.currentCopy(true)))
            }
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {!copy && !startedRestore && !failure && !isLoading ? (
        <p className="notice">
          {projectId
            ? `${games.find((item) => item.id === projectId)?.name ?? t('common.unknown')} · ${t('game.noTask')}`
            : t('task.none')}
        </p>
      ) : null}
      {shownKind === 'copy' && copy && copyState && binding ? (
        <>
          {/* 本机发起时这条提示已在计划页显示过；对方发起时本机没有计划页，在这里显示。 */}
          {copyState.local.role === 'receiver' && peerInitiatedJobIds.has(copyState.jobId) ? (
            <ModifiedDateNotice plan={copy.plan} />
          ) : null}
          <SyncTaskSummary
            key={copyState.jobId}
            gameName={copyGame?.name ?? t('common.unknown')}
            source={isLocalSource ? localEnd : remoteEnd}
            target={isLocalSource ? remoteEnd : localEnd}
            local={copyState.local}
            remote={copyState.remote}
            remoteError={copyState.remoteError}
            onRetryCleanup={
              isCopyRunning || !copyState.local.cleanupError
                ? null
                : () => act(() => sync.cleanupCopy())
            }
            // 备份建在被写入的一端；本机发送时备份在对方设备上，这里不提供入口。
            onViewBackup={
              copyState.local.role === 'receiver' && copy.plan.shouldBackup
                ? () => onBackup(binding.projectId)
                : null
            }
            renderTechnicalDetails={(text) => <TechnicalDetails text={text} />}
            shouldBackup={copy.plan.shouldBackup}
          />
          {isCopyRunning ? <p className="foot-note">{t('task.backgroundNote')}</p> : null}
          {isCopyRunning ? (
            <FloatingAction
              color="danger"
              icon={<StopOutlined />}
              iconPlacement="start"
              label={t('task.cancel')}
              isDisabled={isBusy}
              isLoading={false}
              onClick={() => act(() => sync.cancelCopy(copyState.jobId))}
            />
          ) : (
            <FloatingAction
              color="primary"
              icon={<ReloadOutlined />}
              iconPlacement="start"
              label={t('task.rescan')}
              isDisabled={isBusy}
              isLoading={false}
              onClick={() =>
                onRescan(binding.projectId, binding.remoteDeviceId, copy.preview.direction)
              }
            />
          )}
        </>
      ) : null}
      {shownKind === 'restore' && startedRestore ? (
        <>
          <RestoreSummary
            key={startedRestore.state.restoreId}
            gameName={restoreGame?.name ?? t('common.unknown')}
            source={{ name: restoreSourceName ?? t('backup.list'), kind: 'backup' }}
            target={localEnd}
            restoreId={startedRestore.state.restoreId}
            status={startedRestore.state.status}
            stage={startedRestore.state.stage}
            failureStage={startedRestore.state.failureStage}
            updatedAt={startedRestore.state.updatedAt}
            progress={startedRestore.state.progress}
            result={startedRestore.state.result}
            error={startedRestore.state.error}
            cleanupError={startedRestore.state.result?.cleanupError ?? null}
            onRetryCleanup={
              !isRestoreRunning && startedRestore.state.result?.cleanupError && !isBusy
                ? () => act(() => sync.cleanupRestore())
                : null
            }
            onViewBackup={() => onBackup(startedRestore.state.projectId)}
            renderTechnicalDetails={(text) => <TechnicalDetails text={text} />}
          />
          {isRestoreRunning ? (
            <FloatingAction
              color="danger"
              icon={<StopOutlined />}
              iconPlacement="start"
              label={t('backup.cancelRestore')}
              isDisabled={isBusy}
              isLoading={false}
              onClick={() => act(() => sync.cancelRestore(startedRestore.state.restoreId))}
            />
          ) : null}
        </>
      ) : null}
      {shownKind === 'copy' && startedRestore && restoreSwitchStatus ? (
        <div className="ss-task-group">
          <button
            type="button"
            className="ss-task-row ss-pressable"
            onClick={() => setSelectedKind('restore')}
          >
            <span className="ss-task-lead is-accent">
              <HistoryOutlined />
            </span>
            <span className="ss-task-body">
              {restoreGame?.name ?? t('common.unknown')} · {t('backup.restoreTask')}
              <small>{restoreSwitchStatus}</small>
            </span>
            <RightOutlined className="ss-task-chevron" />
          </button>
        </div>
      ) : null}
      {shownKind === 'restore' && copy && copySwitchStatus ? (
        <div className="ss-task-group">
          <button
            type="button"
            className="ss-task-row ss-pressable"
            onClick={() => setSelectedKind('copy')}
          >
            <span className="ss-task-lead is-accent">
              <SwapOutlined />
            </span>
            <span className="ss-task-body">
              {copyGame?.name ?? t('common.unknown')} · {t('page.task')}
              <small>{copySwitchStatus}</small>
            </span>
            <RightOutlined className="ss-task-chevron" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
