import type { SyncJobState, Translate } from '@savedata-sync/shared'
import type { DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'

const SYNC_STATUS = {
  sent: 'task.sent',
  succeeded: 'task.done',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
  unknown: 'task.unknown',
} as const
const RESTORE_STATUS = {
  succeeded: 'backup.restored',
  failed: 'backup.restoreFailed',
  cancelled: 'backup.restoreCancelled',
  unknown: 'task.unknown',
} as const

export function syncStateTitle(
  t: Translate,
  state: Pick<SyncJobState, 'status' | 'stage'>,
): string {
  return state.status === 'running' ? t(`task.stage.${state.stage}`) : t(SYNC_STATUS[state.status])
}
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
