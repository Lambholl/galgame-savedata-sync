import { useState } from 'react'
import { Alert, Button, Skeleton } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import type { LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import { SyncTaskSummary, useT } from '@savedata-sync/shared/ui'
import type { PlanEndpoint } from '@savedata-sync/shared/ui'
import type { DesktopCopySummary } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { useCopyDetails } from './use-sync-details.ts'

/** 电脑只看得到本机角色；电脑发送时，手机写入结果在手机查看。 */
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
  readonly onOpenBackup: (projectId: string, rootId: string) => void
  readonly onRescan: (projectId: string, peerId: string) => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  const resource = useCopyDetails(task.jobId)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const state = resource.data?.state
  const plan = resource.data?.request?.plan
  const game = games.find((item) => item.id === task.projectId)
  const peer = peers.find((item) => item.device.id === task.peerId)
  function act(action: 'cancel' | 'cleanup'): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    async function work(): Promise<void> {
      if (action === 'cancel') {
        unwrap(await desktopSync().cancelCopy(task.jobId))
      } else {
        unwrap(await desktopSync().cleanupCopy(task.jobId))
      }
    }
    void work()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : ''))
      .finally(() => {
        resource.reload()
        onChanged()
        setIsBusy(false)
      })
  }
  const pcEnd: PlanEndpoint = { name: t('transfer.local'), kind: 'pc' }
  const phoneEnd: PlanEndpoint = { name: peer?.device.name ?? t('common.unknown'), kind: 'phone' }
  const isUpload = task.direction === 'android-to-windows'
  const isRunning = (state ?? task).status === 'running'
  const failure = error || resource.error
  return (
    <div className="library-stack">
      {failure && (
        <Alert
          showIcon
          type="error"
          title={t('task.readFailed', { message: failure })}
          action={
            <Button size="small" onClick={resource.reload}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {state ? (
        <SyncTaskSummary
          gameName={game?.name ?? t('common.unknown')}
          source={isUpload ? phoneEnd : pcEnd}
          target={isUpload ? pcEnd : phoneEnd}
          local={state}
          remote={null}
          remoteError={null}
          onRetryCleanup={state.cleanupError && !isRunning ? () => act('cleanup') : null}
        />
      ) : (
        resource.isLoading && <Skeleton active />
      )}
      <div className="task-actions">
        {isRunning ? (
          <Button danger disabled={isBusy} onClick={() => act('cancel')}>
            {t('task.cancel')}
          </Button>
        ) : (
          <>
            {state?.role === 'receiver' && plan && (
              <Button onClick={() => onOpenBackup(task.projectId, plan.target.rootId)}>
                {t('task.viewBackup')}
              </Button>
            )}
            <Button type="primary" onClick={() => onRescan(task.projectId, task.peerId)}>
              {t('task.rescan')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
