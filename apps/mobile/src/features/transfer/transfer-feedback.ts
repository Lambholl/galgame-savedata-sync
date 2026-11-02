import type { OperationError, SyncTransferState } from '@savedata-sync/shared'

/** 传输结束提示：语气、文案键与失败原因（有原因时作为文案后的说明）。 */
export interface TransferFeedback {
  readonly type: 'success' | 'error' | 'warning' | 'info'
  readonly text:
    | 'task.done'
    | 'task.cleanupPending'
    | 'task.failed'
    | 'task.unknown'
    | 'task.cancelled'
    | 'task.unknownDetail'
  readonly error: OperationError | null
}

/** 提示依据实际接收结果；已发送、待确认与完整成功分开，清理错误独立保留。 */
export function transferFeedback(state: SyncTransferState): TransferFeedback | null {
  const receiver = state.local.role === 'receiver' ? state.local : state.remote
  if (receiver?.status === 'succeeded') {
    return receiver.cleanupError || state.local.cleanupError
      ? { type: 'warning', text: 'task.cleanupPending', error: null }
      : { type: 'success', text: 'task.done', error: null }
  }
  const failed =
    receiver?.status === 'failed' ? receiver : state.local.status === 'failed' ? state.local : null
  if (failed) {
    return { type: 'error', text: 'task.failed', error: failed.error }
  }
  if (receiver?.status === 'unknown' || state.local.status === 'unknown') {
    return { type: 'warning', text: 'task.unknown', error: null }
  }
  if (receiver?.status === 'cancelled' || state.local.status === 'cancelled') {
    return { type: 'info', text: 'task.cancelled', error: null }
  }
  if (state.local.status === 'sent' && state.remoteError) {
    return { type: 'warning', text: 'task.unknownDetail', error: null }
  }
  return null
}
