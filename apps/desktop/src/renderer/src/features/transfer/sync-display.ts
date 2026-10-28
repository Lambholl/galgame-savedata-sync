import type { SyncJobState } from '@savedata-sync/shared'
import type { DesktopRestoreSummary } from '../../../../bridge/sync-bridge.ts'

const STAGES: Readonly<Record<SyncJobState['stage'], string>> = {
  preparing: '准备文件',
  ready: '等待接收',
  'awaiting-content': '等待接收',
  transferring: '传输中',
  verifying: '核对内容',
  'backing-up': '备份目标旧内容',
  writing: '写入目标',
  cleaning: '清理资源',
  done: '已结束',
}
export function syncStateTitle(state: Pick<SyncJobState, 'status' | 'stage'>): string {
  return state.status === 'running'
    ? STAGES[state.stage]
    : {
        sent: '发送完成',
        succeeded: '写入成功',
        failed: '失败',
        cancelled: '已取消',
        unknown: '结果待确认',
      }[state.status]
}
export function restoreStateTitle(state: DesktopRestoreSummary): string {
  if (state.status === 'preparing') {
    return '扫描当前目录并核实备份'
  }
  if (state.status === 'ready') {
    return '等待确认恢复'
  }
  if (state.isWorking && state.status !== 'running') {
    return '写入已结束，正在清理'
  }
  return state.status === 'running'
    ? STAGES[state.stage]
    : {
        succeeded: '恢复成功',
        failed: '恢复失败',
        cancelled: '已取消',
        unknown: '结果待确认',
      }[state.status]
}
