import type { SyncTransferState } from '@savedata-sync/shared'

/** 提示依据实际接收结果；已发送、待确认与完整成功分开，清理错误独立保留。 */
export function transferFeedback(state: SyncTransferState): {
  readonly type: 'success' | 'error' | 'warning' | 'info'
  readonly content: string
} | null {
  const receiver = state.local.role === 'receiver' ? state.local : state.remote
  if (receiver?.status === 'succeeded') {
    return receiver.cleanupError || state.local.cleanupError
      ? { type: 'warning', content: '文件传输完成，清理尚未完成，请查看任务详情。' }
      : { type: 'success', content: '传输成功' }
  }
  const failed =
    receiver?.status === 'failed' ? receiver : state.local.status === 'failed' ? state.local : null
  if (failed) {
    return { type: 'error', content: `传输失败：${failed.error?.message ?? '请查看逐项结果。'}` }
  }
  if (receiver?.status === 'unknown' || state.local.status === 'unknown') {
    return { type: 'warning', content: '传输结果待确认，请查看任务详情。' }
  }
  if (receiver?.status === 'cancelled' || state.local.status === 'cancelled') {
    return { type: 'info', content: '传输已取消' }
  }
  if (state.local.status === 'sent' && state.remoteError) {
    return { type: 'warning', content: '文件已发送，目标写入结果待确认。' }
  }
  return null
}
