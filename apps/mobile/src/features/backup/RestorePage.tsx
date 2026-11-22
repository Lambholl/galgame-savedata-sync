import { useState } from 'react'
import { LoadingOutlined } from '@ant-design/icons'
import { toShownError } from '@savedata-sync/shared'
import type { ShownError } from '@savedata-sync/shared'
import { ErrorText, useT } from '@savedata-sync/shared/ui'
import type { MobileRestoreDetails, MobileSyncAdapter } from '../../platform/sync-adapter'
import { PlanConfirm } from '../transfer/PlanConfirm'

/** 恢复预览页：准备中显示等待提示，就绪后展示恢复计划，确认启动后触发 onStarted。 */
export function RestorePage({
  sync,
  restore,
  rootId,
  sourceName,
  isDisabled,
  onStarted,
  onChanged,
  onFailure,
}: {
  readonly sync: MobileSyncAdapter
  /** 当前打开的这次恢复；还没查到时为 null，按准备中显示。 */
  readonly restore: MobileRestoreDetails | null
  /** 游戏当前的目录；与这次恢复准备时的目录不同时不能恢复。 */
  readonly rootId: string | null
  /** 计划里来源一端的名称，通常是备份时间。 */
  readonly sourceName: string
  readonly isDisabled: boolean
  /** 确认恢复并成功启动后触发。 */
  readonly onStarted: (restoreId: string, sourceName: string) => Promise<void>
  readonly onChanged: () => void
  readonly onFailure: (error: ShownError) => void
}): React.JSX.Element {
  const t = useT()
  const [isStarting, setIsStarting] = useState(false)
  const state = restore?.state
  const plan = restore?.plan

  function start(restoreId: string): void {
    if (isStarting) {
      return
    }
    setIsStarting(true)
    sync
      .executeRestore(restoreId)
      .then(() => onStarted(restoreId, sourceName))
      .catch((cause: unknown) => {
        onFailure(toShownError(cause))
        onChanged()
      })
      .finally(() => {
        setIsStarting(false)
      })
  }

  if (state?.status === 'ready' && plan) {
    const hasFolderChanged = state.rootId !== rootId
    return (
      <PlanConfirm
        plan={plan}
        source={{ name: sourceName, kind: 'backup' }}
        target={{ name: t('transfer.local'), kind: 'mobile' }}
        notice={
          hasFolderChanged ? (
            <p className="notice notice-warning">{t('backup.folderChanged')}</p>
          ) : null
        }
        action={{
          label: t('backup.confirmRestore'),
          isDisabled: isDisabled || !plan.canExecute || hasFolderChanged,
          isLoading: isStarting,
          onClick: () => start(state.restoreId),
        }}
      />
    )
  }

  if (state && state.status !== 'preparing' && state.status !== 'ready') {
    return (
      <div className="empty-state">
        <p>
          {state.error ? (
            <ErrorText error={state.error} context={t('backup.restoreFailed')} />
          ) : (
            t('backup.restoreCancelled')
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="ss-task">
      <div className="ss-task-hero">
        <p className="ss-task-wait">
          <LoadingOutlined /> {t('backup.preparing')}
        </p>
      </div>
    </div>
  )
}
