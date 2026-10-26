import type { BatchState } from '@savedata-sync/shared'

/** null 显示未知，0 显示空文件的实际字节数。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return '未知'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** 时间来自条目自身或本次读取，不参与方向判断。 */
export function formatDate(time: number | null): string {
  return time === null ? '未知' : new Date(time).toLocaleString('zh-CN', { hour12: false })
}

/** 展示报告端实际阶段，发送完成与目标发布成功分开。 */
export function describeState(state: BatchState): string {
  if (state.status === 'running') {
    const stages = {
      preparing: '准备文件',
      ready: '等待领取',
      'awaiting-content': '等待接收',
      transferring: '传输中',
      verifying: '校验内容',
      publishing: '写入目标',
      cleaning: '清理临时文件',
    }
    return `${stages[state.stage]}${state.cancelRequested ? ' · 正在取消' : ''}`
  }
  return {
    sent: '发送完成',
    succeeded: '目标写入成功',
    failed: '失败',
    cancelled: '已取消',
    unknown: '结果待确认',
  }[state.status]
}
