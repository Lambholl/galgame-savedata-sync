import type { BatchState } from '@savedata-sync/shared'

/** 字节数只格式化真实计数；null 保留未知语义，0 为实际空文件。 */
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

/** 时间为条目自身时间或读取时间，未知不推断为不存在。 */
export function formatDate(time: number | null): string {
  return time === null ? '未知' : new Date(time).toLocaleString('zh-CN', { hour12: false })
}

/** 发送完成与接收发布成功分别展示；运行阶段来自原生快照。 */
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
