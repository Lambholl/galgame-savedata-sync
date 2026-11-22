import { useEffect, useState } from 'react'
import { Button, Empty, Skeleton } from 'antd'
import { StopOutlined } from '@ant-design/icons'
import { observeRestoreTask, toShownError, unwrap } from '@savedata-sync/shared'
import type { LibraryGame, ShownError } from '@savedata-sync/shared'
import { RestoreSummary, useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message.ts'
import type { DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { useRestoreDetails } from './use-sync-details.ts'
import { TechnicalDetails } from './TechnicalDetails.tsx'

/**
 * 一次本机恢复任务的详情，与复制任务共用同一套进度环、步骤条、结果列表与技术详情布局。
 * 进行中时可以取消恢复，结束后可跳回备份页。
 */
export function SyncRestoreDetails({
  task,
  sourceName,
  games,
  onOpenBackup,
  onChanged,
}: {
  readonly task: DesktopRestoreSummary
  /** 备份来源的显示名，通常是备份时间；未知时为 null。 */
  readonly sourceName: string | null
  readonly games: readonly LibraryGame[]
  readonly onOpenBackup: (projectId: string) => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const t = useT()
  const resource = useRestoreDetails(task.restoreId)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)
  const state = resource.data?.state
  const game = games.find((item) => item.id === task.projectId)

  function act(action: 'cancel' | 'cleanup'): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError(null)
    async function work(): Promise<void> {
      if (action === 'cancel') {
        unwrap(await desktopSync().cancelRestore(task.restoreId))
      } else {
        unwrap(await desktopSync().cleanupRestore(task.restoreId))
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

  const phase = state ? observeRestoreTask(state).phase : task.phase
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
        <RestoreSummary
          gameName={game?.name ?? t('common.unknown')}
          source={{ name: sourceName ?? t('backup.list'), kind: 'backup' }}
          target={{ name: t('transfer.local'), kind: 'pc' }}
          restoreId={state.restoreId}
          status={state.status}
          stage={state.stage}
          failureStage={state.failureStage}
          updatedAt={state.updatedAt}
          progress={state.progress}
          result={state.result}
          error={state.error}
          cleanupError={state.cleanupError}
          onRetryCleanup={state.hasCleanupError && !state.isWorking ? () => act('cleanup') : null}
          onViewBackup={() => onOpenBackup(task.projectId)}
          renderTechnicalDetails={(text) => <TechnicalDetails text={text} />}
        />
      ) : (
        (resource.isLoading && <Skeleton active />) ||
        (failure && (
          <Empty description={t('task.readFailed')}>
            <Button onClick={() => resource.reload()}>{t('common.retry')}</Button>
          </Empty>
        ))
      )}
      {isRunning ? (
        <div className="task-float">
          <Button
            danger
            type="primary"
            size="large"
            icon={<StopOutlined />}
            disabled={isBusy}
            onClick={() => act('cancel')}
          >
            {t('backup.cancelRestore')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
