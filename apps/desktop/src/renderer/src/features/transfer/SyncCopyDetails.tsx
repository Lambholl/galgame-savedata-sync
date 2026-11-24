import { useEffect, useState } from 'react'
import { Button, Empty, Skeleton } from 'antd'
import { ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { observeSyncJob, toShownError, unwrap } from '@savedata-sync/shared'
import type { LibraryGame, LibraryPeer, ShownError } from '@savedata-sync/shared'
import { LocalDeviceProvider, SyncTaskSummary, useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message.ts'
import type { PlanEndpoint } from '@savedata-sync/shared/ui'
import type { DesktopCopySummary } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { useCopyDetails } from './use-sync-details.ts'
import { TechnicalDetails } from './TechnicalDetails.tsx'

/**
 * 一次复制任务的详情，显示两个角色的状态；发送完成而移动端还在写入时仍算进行中。
 * 进行中时可以取消传输，结束后可以重新扫描。
 */
export function SyncCopyDetails({
  task,
  games,
  peers,
  onOpenBackup,
  onRescan,
  onChanged,
}: {
  readonly task: DesktopCopySummary
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly onOpenBackup: (projectId: string) => void
  /** 用这次传输的游戏、设备和方向重新比较；isUpload 为 true 表示从该设备复制到本机。 */
  readonly onRescan: (projectId: string, peerId: string, isUpload: boolean) => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  const resource = useCopyDetails(task.jobId)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)
  const state = resource.data?.state
  const plan = resource.data?.request?.plan
  const game = games.find((item) => item.id === task.projectId)
  const peer = peers.find((item) => item.device.id === task.peerId)
  function act(action: 'cancel' | 'cleanup'): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError(null)
    async function work(): Promise<void> {
      if (action === 'cancel') {
        unwrap(await desktopSync().cancelCopy(task.jobId))
      } else {
        unwrap(await desktopSync().cleanupCopy(task.jobId))
      }
    }
    void work()
      .catch((cause: unknown) => setError(toShownError(cause)))
      .finally(() => {
        resource.reload()
        onChanged()
        setIsBusy(false)
      })
  }
  const localEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'pc' }
  const peerEnd: PlanEndpoint = {
    name: peer?.device.name ?? t('common.unknown'),
    kind: peer?.device.platform === 'windows' ? 'pc' : 'mobile',
  }
  const isUpload = task.role === 'receiver'
  // 按钮和正文读同一份状态；列表摘要另有轮询，用它会出现正文已完成、按钮还是取消的一瞬间。
  const phase = state
    ? observeSyncJob(state.local, state.remote, state.remoteError !== null).phase
    : task.phase
  const isRunning = phase === 'running'
  const failure = error ?? resource.error
  // 失败用 Message 提示一次；读不到任务时正文留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(failure, failure ? t(error ? 'app.actionFailed' : 'task.readFailed') : null)
  }, [failure, error, showFailure, t])
  return (
    <div className="library-stack">
      {failureHolder}
      {state ? (
        <LocalDeviceProvider device={task.localSide}>
          <SyncTaskSummary
            gameName={game?.name ?? t('common.unknown')}
            source={isUpload ? peerEnd : localEnd}
            target={isUpload ? localEnd : peerEnd}
            local={state.local}
            remote={state.remote}
            remoteError={state.remoteError}
            onRetryCleanup={state.local.cleanupError && !isRunning ? () => act('cleanup') : null}
            // 备份建在被写入的一端；本机发送时备份在移动端上，这里不提供入口。
            onViewBackup={
              state.local.role === 'receiver' && plan?.shouldBackup
                ? () => onOpenBackup(task.projectId)
                : null
            }
            renderTechnicalDetails={(text) => <TechnicalDetails text={text} />}
            isAwaitingPeer={task.isAwaitingPeer}
            shouldBackup={task.shouldBackup}
          />
        </LocalDeviceProvider>
      ) : (
        (resource.isLoading && <Skeleton active />) ||
        (failure && (
          <Empty description={t('task.readFailed')}>
            <Button onClick={() => resource.reload()}>{t('common.retry')}</Button>
          </Empty>
        ))
      )}
      {/* 悬浮在窗口底边；滚到最后时回到内容下方，不遮住最后一行。 */}
      <div className="task-float">
        {isRunning ? (
          <Button
            danger
            type="primary"
            size="large"
            icon={<StopOutlined />}
            disabled={isBusy}
            onClick={() => act('cancel')}
          >
            {t('task.cancel')}
          </Button>
        ) : (
          <Button
            type="primary"
            size="large"
            icon={<ReloadOutlined />}
            onClick={() => onRescan(task.projectId, task.peerId, isUpload)}
          >
            {t('task.rescan')}
          </Button>
        )}
      </div>
    </div>
  )
}
