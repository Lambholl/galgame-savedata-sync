import { useState } from 'react'
import { Alert, Button, Skeleton } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import { RestoreSummary, SyncPlanSummary, useT } from '@savedata-sync/shared/ui'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { useRestoreDetails } from '../transfer/use-sync-details.ts'

/** 取消准备中或待确认的恢复并释放；原生仍在收尾时稍等。 */
async function discardRestore(restoreId: string): Promise<void> {
  const api = desktopSync()
  let state = unwrap(await api.cancelRestore(restoreId))
  for (let index = 0; index < 100 && state.isWorking; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    state = unwrap(await api.restoreState(restoreId))
  }
  if (state.cleanupError) {
    throw new Error(state.cleanupError.message)
  }
  unwrap(await api.releaseRestore(restoreId))
}

/**
 * 一次本机恢复：待确认时显示恢复预览（与传输计划同一套数字与列表），确认后原地显示进度和结果。
 * 关闭页面不取消原生已经接纳的恢复。
 */
export function RestoreDetails({
  restoreId,
  sourceName,
  isActive,
  onClose,
  onChanged,
  onOpenBackup,
}: {
  readonly restoreId: string
  /** 所选备份的显示名，通常是备份时间。 */
  readonly sourceName: string
  readonly isActive: boolean
  /** 返回上一层；准备中或待确认时先取消并释放这次恢复。 */
  readonly onClose: () => void
  readonly onChanged: () => void
  /** 打开这次恢复所在游戏的备份页；已经在备份页时为 null。 */
  readonly onOpenBackup: ((projectId: string, rootId: string) => void) | null
}): React.JSX.Element {
  const t = useT()
  const resource = useRestoreDetails(restoreId)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const state = resource.data?.state
  const plan = resource.data?.plan
  function run(work: () => Promise<void>, after?: () => void): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    void work()
      .then(after)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : ''))
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
  const failure = error || resource.error
  const isReady = state?.status === 'ready' && plan
  return (
    <div className="library-stack">
      {failure && (
        <Alert
          showIcon
          type="error"
          title={failure}
          action={
            <Button size="small" onClick={resource.reload}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {!state ? (
        resource.isLoading && <Skeleton active />
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
          error={state.error?.message ?? null}
          cleanupError={state.cleanupError?.message ?? null}
          onRetryCleanup={
            state.hasCleanupError && !state.isWorking
              ? () => run(async () => void unwrap(await desktopSync().cleanupRestore(restoreId)))
              : null
          }
        />
      )}
      <div className="task-actions">
        {state?.status === 'running' ? (
          <Button
            danger
            disabled={isBusy}
            onClick={() =>
              run(async () => void unwrap(await desktopSync().cancelRestore(restoreId)))
            }
          >
            {t('task.cancel')}
          </Button>
        ) : (
          <>
            {state && onOpenBackup && (
              <Button onClick={() => onOpenBackup(state.projectId, state.rootId)}>
                {t('task.viewBackup')}
              </Button>
            )}
            <Button disabled={isBusy} onClick={close}>
              {isReady || state?.status === 'preparing' ? t('backup.back') : t('backup.done')}
            </Button>
            {isReady && (
              <Button
                type="primary"
                loading={isBusy}
                disabled={isActive || !plan.canExecute || state.hasCleanupError}
                onClick={() =>
                  run(async () => void unwrap(await desktopSync().executeRestore(restoreId, plan)))
                }
              >
                {t('backup.confirmRestore')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
