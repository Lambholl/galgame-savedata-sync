import { useState } from 'react'
import { HistoryOutlined } from '@ant-design/icons'
import { toShownError } from '@savedata-sync/shared'
import type { ShownError } from '@savedata-sync/shared'
import { RestoreSummary, useT } from '@savedata-sync/shared/ui'
import type { MobileRestoreDetails, MobileSyncAdapter } from '../../platform/sync-adapter'
import { FloatingAction } from '../../components/FloatingAction'
import { PlanConfirm } from '../transfer/PlanConfirm'

/** 恢复页：待确认时显示恢复预览，确认后在同一页显示进度和结果。 */
export function RestorePage({
  sync,
  restore,
  rootId,
  sourceName,
  isDisabled,
  onChanged,
  onDone,
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
  readonly onChanged: () => void
  readonly onDone: () => void
  readonly onFailure: (error: ShownError) => void
}): React.JSX.Element {
  const t = useT()
  const [isBusy, setIsBusy] = useState(false)
  const state = restore?.state
  const plan = restore?.plan
  function run(work: () => Promise<unknown>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    work()
      .catch((cause: unknown) => onFailure(toShownError(cause)))
      .finally(() => {
        setIsBusy(false)
        onChanged()
      })
  }
  if (state?.status === 'ready' && plan) {
    const hasFolderChanged = state.rootId !== rootId
    return (
      <PlanConfirm
        plan={plan}
        source={{ name: sourceName, kind: 'backup' }}
        target={{ name: t('transfer.local'), kind: 'mobile' }}
        backupKeepCount={null}
        notice={
          hasFolderChanged && <p className="notice notice-warning">{t('backup.folderChanged')}</p>
        }
        action={{
          label: t('backup.confirmRestore'),
          isDisabled: isDisabled || !plan.canExecute || hasFolderChanged,
          isLoading: isBusy,
          onClick: () => run(() => sync.executeRestore(state.restoreId)),
        }}
      />
    )
  }
  const phase = !state || state.status === 'ready' ? 'preparing' : state.status
  return (
    <>
      <RestoreSummary
        phase={phase}
        progress={null}
        result={state?.result ?? null}
        error={state?.error ?? null}
        cleanupError={null}
        onRetryCleanup={
          state?.result?.cleanupError && !isBusy ? () => run(() => sync.cleanupRestore()) : null
        }
      />
      {phase !== 'preparing' && phase !== 'running' && (
        <FloatingAction
          color="primary"
          icon={<HistoryOutlined />}
          iconPlacement="start"
          label={t('task.viewBackup')}
          isDisabled={isBusy}
          isLoading={false}
          onClick={onDone}
        />
      )}
    </>
  )
}
