import { useEffect, useState } from 'react'
import { Button } from 'antd-mobile'
import { ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { toShownError } from '@savedata-sync/shared'
import type { LibraryGame, LibraryPeer, ShownError } from '@savedata-sync/shared'
import { SyncTaskSummary, useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message'
import type { PlanEndpoint } from '@savedata-sync/shared/ui'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'
import { Panel } from '../../components/Panel'
import { FloatingAction } from '../../components/FloatingAction'
import { TechnicalDetails } from './TechnicalDetails'

const RESTORE_STATUS = {
  preparing: 'backup.status.preparing',
  ready: 'backup.status.ready',
  running: 'backup.status.running',
  succeeded: 'backup.restored',
  failed: 'backup.restoreFailed',
  cancelled: 'backup.restoreCancelled',
} as const

/**
 * 先给结论再给细节；目标是否写入成功只依据接收端回读的结果。
 * 右下角只悬浮当下能做的一件事：进行中取消传输，结束后重新扫描；查看备份是技术详情上方的一行。
 */
export function SyncTaskDetails({
  projectId,
  sync,
  copy,
  restore,
  games,
  peers,
  errors,
  onChanged,
  onRescan,
  onBackup,
}: {
  readonly projectId: string | null
  readonly sync: MobileSyncAdapter
  readonly copy: MobileCopyDetails | null
  readonly restore: MobileRestoreDetails | null
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly errors: readonly ShownError[]
  readonly onChanged: () => void
  readonly onRescan: (projectId: string, deviceId: string) => void
  readonly onBackup: (projectId: string) => void
}): React.JSX.Element {
  const t = useT()
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
  const state = copy?.state
  const binding = copy?.preview.binding
  const game = games.find((item) => item.id === binding?.projectId)
  const peer = peers.find((item) => item.device.id === binding?.remoteDeviceId)
  const isRunning = state?.local.status === 'running' || state?.remote?.status === 'running'
  const phoneEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'phone' }
  const pcEnd: PlanEndpoint = { name: peer?.device.name ?? t('common.unknown'), kind: 'pc' }
  const isUpload = copy?.preview.direction === 'android-to-windows'
  const failure = error ?? errors[0] ?? null
  // 失败用 Message 提示一次；读不到任务时正文留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(failure, failure ? t(error ? 'app.actionFailed' : 'task.readFailed') : null)
  }, [failure, error, showFailure, t])
  return (
    <div className="page-stack">
      {failureHolder}
      {!copy && !restore && failure && (
        <div className="empty-state">
          <p>{t('task.readFailed')}</p>
          <Button size="small" disabled={isBusy} onClick={() => act(() => sync.currentCopy(true))}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!copy && !restore && !failure && (
        <p className="notice">
          {projectId
            ? `${games.find((item) => item.id === projectId)?.name ?? t('common.unknown')} · ${t('game.noTask')}`
            : t('task.none')}
        </p>
      )}
      {copy && state && binding && (
        <>
          <SyncTaskSummary
            key={state.jobId}
            gameName={game?.name ?? t('common.unknown')}
            source={isUpload ? phoneEnd : pcEnd}
            target={isUpload ? pcEnd : phoneEnd}
            local={state.local}
            remote={state.remote}
            remoteError={state.remoteError}
            onRetryCleanup={
              isRunning || !state.local.cleanupError ? null : () => act(() => sync.cleanupCopy())
            }
            // 备份建在被写入的一端；手机发送时备份在电脑上，这里不提供入口。
            onViewBackup={
              state.local.role === 'receiver' ? () => onBackup(binding.projectId) : null
            }
            renderTechnicalDetails={(text) => <TechnicalDetails text={text} />}
          />
          {isRunning && <p className="foot-note">{t('task.backgroundNote')}</p>}
          {isRunning ? (
            <FloatingAction
              color="danger"
              icon={<StopOutlined />}
              iconPlacement="start"
              label={t('task.cancel')}
              isDisabled={isBusy}
              isLoading={false}
              onClick={() => act(() => sync.cancelCopy(state.jobId))}
            />
          ) : (
            <FloatingAction
              color="primary"
              icon={<ReloadOutlined />}
              iconPlacement="start"
              label={t('task.rescan')}
              isDisabled={isBusy}
              isLoading={false}
              onClick={() => onRescan(binding.projectId, binding.remoteDeviceId)}
            />
          )}
        </>
      )}
      {restore && (
        <Panel title={t('backup.restoreTask')}>
          <p>
            {games.find((item) => item.id === restore.state.projectId)?.name ?? t('common.unknown')}{' '}
            · {t(RESTORE_STATUS[restore.state.status])}
          </p>
          <Button onClick={() => onBackup(restore.state.projectId)}>
            {t('backup.openRestore')}
          </Button>
        </Panel>
      )}
    </div>
  )
}
