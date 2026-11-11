import type { Translate } from '@savedata-sync/shared'
import type { DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'

const RESTORE_STATUS = {
  succeeded: 'backup.restored',
  failed: 'backup.restoreFailed',
  cancelled: 'backup.restoreCancelled',
  unknown: 'task.unknown',
} as const

/** 恢复任务当前状态的标题。 */
export function restoreStateTitle(t: Translate, state: DesktopRestoreSummary): string {
  if (state.status === 'preparing' || state.status === 'ready') {
    return t(`backup.status.${state.status}`)
  }
  if (state.isWorking && state.status !== 'running') {
    return t('task.stage.cleaning')
  }
  return state.status === 'running'
    ? t(`task.stage.${state.stage}`)
    : t(RESTORE_STATUS[state.status])
}
