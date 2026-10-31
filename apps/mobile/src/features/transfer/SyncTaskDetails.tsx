import { useState } from 'react'
import { Button } from 'antd-mobile'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { SyncTaskSummary, useT } from '@savedata-sync/shared/ui'
import type { PlanEndpoint } from '@savedata-sync/shared/ui'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'
import { Panel } from '../../components/Panel'

const RESTORE_STATUS = {
  preparing: '准备中',
  ready: '等待确认',
  running: '恢复中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
} as const

/** 先给结论再给细节；目标是否写入成功只依据接收端回读的结果。 */
export function SyncTaskDetails({
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
  readonly sync: MobileSyncAdapter
  readonly copy: MobileCopyDetails | null
  readonly restore: MobileRestoreDetails | null
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly errors: readonly string[]
  readonly onChanged: () => void
  readonly onRescan: (projectId: string, deviceId: string) => void
  readonly onBackup: (projectId: string) => void
}): React.JSX.Element {
  const t = useT()
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  function act(work: () => Promise<unknown>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    work()
      .then(onChanged)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('common.unknown'))
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
  const failures = [...errors, ...(error ? [error] : [])]
  return (
    <div className="page-stack">
      {failures.map((value, index) => (
        <div className="notice notice-error" role="alert" key={index}>
          <p>{t('task.readFailed', { message: value })}</p>
          <Button size="small" disabled={isBusy} onClick={() => act(() => sync.currentCopy(true))}>
            {t('common.retry')}
          </Button>
        </div>
      ))}
      {!copy && !restore && !failures.length && <p className="notice">{t('task.none')}</p>}
      {copy && state && binding && (
        <>
          <SyncTaskSummary
            key={state.jobId}
            gameName={game?.name ?? t('common.unknown')}
            source={isUpload ? phoneEnd : pcEnd}
            target={isUpload ? pcEnd : phoneEnd}
            local={state.local}
            remote={state.remote}
            remoteError={state.remoteError?.message ?? null}
            onRetryCleanup={
              isRunning || !state.local.cleanupError ? null : () => act(() => sync.cleanupCopy())
            }
          />
          {isRunning ? (
            <>
              <p className="foot-note">{t('task.backgroundNote')}</p>
              <Button
                block
                color="danger"
                fill="outline"
                disabled={isBusy}
                onClick={() => act(() => sync.cancelCopy(state.jobId))}
              >
                {t('task.cancel')}
              </Button>
            </>
          ) : (
            <div className="action-row equal">
              <Button onClick={() => onBackup(binding.projectId)}>{t('task.viewBackup')}</Button>
              <Button
                color="primary"
                disabled={isBusy}
                onClick={() => onRescan(binding.projectId, binding.remoteDeviceId)}
              >
                {t('task.rescan')}
              </Button>
            </div>
          )}
        </>
      )}
      {restore && (
        <Panel title="本机恢复任务">
          <p>
            {games.find((item) => item.id === restore.state.projectId)?.name ?? '本次记录的项目'} ·{' '}
            {RESTORE_STATUS[restore.state.status]}
          </p>
          <Button onClick={() => onBackup(restore.state.projectId)}>查看恢复预览与实际结果</Button>
        </Panel>
      )}
    </div>
  )
}
