import { useEffect, useState } from 'react'
import { Button, Empty, Skeleton } from 'antd'
import { OperationFailure, toShownError, unwrap } from '@savedata-sync/shared'
import type { ShownError } from '@savedata-sync/shared'
import { CaretRightOutlined, HistoryOutlined, StopOutlined } from '@ant-design/icons'
import { RestoreSummary, SyncPlanSummary, useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { useRestoreDetails } from '../transfer/use-sync-details.ts'
import { PlanDrawer } from '../transfer/PlanDrawer.tsx'
import type { PlanDrawerAction } from '../transfer/PlanDrawer.tsx'

/** 取消准备中或待确认的恢复，等它停止后释放；清理失败时抛错。 */
async function discardRestore(restoreId: string): Promise<void> {
  const api = desktopSync()
  let state = unwrap(await api.cancelRestore(restoreId))
  for (let index = 0; index < 100 && state.isWorking; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    state = unwrap(await api.restoreState(restoreId))
  }
  if (state.cleanupError) {
    throw new OperationFailure(state.cleanupError.code, state.cleanupError.message)
  }
  unwrap(await api.releaseRestore(restoreId))
}

/** 一次本机恢复的抽屉：待确认时显示恢复预览，确认后显示进度和结果。关闭抽屉不取消已开始的恢复。 */
export function RestoreDetails({
  restoreId,
  gameName,
  sourceName,
  isActive,
  onClose,
  onChanged,
  onOpenBackup,
}: {
  readonly restoreId: string
  /** 抽屉标题右侧的游戏名。 */
  readonly gameName: string
  /** 所选备份的显示名，通常是备份时间。 */
  readonly sourceName: string
  readonly isActive: boolean
  /** 关闭抽屉；准备中或待确认时先取消并释放这次恢复。 */
  readonly onClose: () => void
  readonly onChanged: () => void
  /** 打开这次恢复所在游戏的备份页；已经在备份页时为 null。 */
  readonly onOpenBackup: ((projectId: string) => void) | null
}): React.JSX.Element {
  const t = useT()
  const resource = useRestoreDetails(restoreId)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)
  const state = resource.data?.state
  const plan = resource.data?.plan
  function run(work: () => Promise<void>, after?: () => void): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError(null)
    void work()
      .then(after)
      .catch((cause: unknown) => setError(toShownError(cause)))
      .finally(() => {
        resource.reload()
        onChanged()
        setIsBusy(false)
      })
  }
  function close(): void {
    if (state && (state.status === 'preparing' || state.status === 'ready')) {
      run(() => discardRestore(restoreId), onClose)
    } else {
      onClose()
    }
  }
  const failure = error ?? resource.error
  // 失败用 Message 提示一次；读不到任务时正文留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(failure, failure ? t(error ? 'app.actionFailed' : 'task.readFailed') : null)
  }, [failure, error, showFailure, t])
  const isReady = state?.status === 'ready' && plan
  let action: PlanDrawerAction | null = null
  if (isReady) {
    action = {
      label: t('backup.confirmRestore'),
      icon: <CaretRightOutlined />,
      isDanger: false,
      isLoading: isBusy,
      isDisabled: isActive || !plan.canExecute || state.hasCleanupError,
      onClick: () =>
        run(async () => void unwrap(await desktopSync().executeRestore(restoreId, plan))),
    }
  } else if (state?.status === 'running') {
    action = {
      label: t('task.cancel'),
      icon: <StopOutlined />,
      isDanger: true,
      isLoading: false,
      isDisabled: isBusy,
      onClick: () => run(async () => void unwrap(await desktopSync().cancelRestore(restoreId))),
    }
  } else if (state && state.status !== 'preparing' && onOpenBackup) {
    action = {
      label: t('task.viewBackup'),
      icon: <HistoryOutlined />,
      isDanger: false,
      isLoading: false,
      isDisabled: false,
      onClick: () => onOpenBackup(state.projectId),
    }
  }
  return (
    <PlanDrawer
      isOpen
      title={t('backup.restoreTask')}
      gameName={gameName}
      action={action}
      onClose={close}
    >
      {failureHolder}
      {!state ? (
        (resource.isLoading && <Skeleton active />) ||
        (failure && (
          <Empty description={t('task.readFailed')}>
            <Button onClick={resource.reload}>{t('common.retry')}</Button>
          </Empty>
        ))
      ) : isReady ? (
        <SyncPlanSummary
          key={plan.planId}
          plan={plan}
          source={{ name: sourceName, kind: 'backup' }}
          target={{ name: t('transfer.local'), kind: 'pc' }}
          backupKeepCount={null}
        />
      ) : (
        <RestoreSummary
          phase={state.status === 'ready' ? 'preparing' : state.status}
          progress={
            state.progress.totalFiles > 0
              ? { done: state.progress.publishedFiles, total: state.progress.totalFiles }
              : null
          }
          result={state.result}
          error={state.error ?? null}
          cleanupError={state.cleanupError ?? null}
          onRetryCleanup={
            state.hasCleanupError && !state.isWorking
              ? () => run(async () => void unwrap(await desktopSync().cleanupRestore(restoreId)))
              : null
          }
        />
      )}
    </PlanDrawer>
  )
}
