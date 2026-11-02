import type { Translate } from '../../i18n/translate.ts'
import type { SyncJobObservation, SyncTaskPhase } from '../../sync/sync-job-observation.ts'
import type { TransferTask } from '../../transfer/transfer.ts'
import { taskIsActive } from '../../transfer/transfer.ts'

/** 五段进度的本地化键。 */
export const SYNC_TASK_STEPS = [
  'task.step.pack',
  'task.step.transfer',
  'task.step.verify',
  'task.step.backup',
  'task.step.write',
] as const

/** 编号步骤条所需的数据。 */
export interface TaskStepProgress {
  /** 零起点阶段，5 表示全部完成；null 表示阶段未记录。 */
  readonly current: number | null
  /** 当前阶段的完成百分比，未知时使用起始刻度。 */
  readonly percent: number | null
}

/** 游戏面板和列表横条所需的短状态。 */
export interface TaskPreview {
  /** 本地化后的当前阶段或结果。 */
  readonly status: string
  /** 当前阶段百分比；缺少计数或接收端结果时为 null。 */
  readonly percent: number | null
  /** 决定图标与语义色的任务状态。 */
  readonly phase: SyncTaskPhase
  /** 复制任务的五段步骤；恢复或旧任务使用 null。 */
  readonly steps: TaskStepProgress | null
}

/** 任务观察结果生成横条和历史用的短状态；清理失败优先提示。 */
export function syncTaskPreview(
  observation: Pick<SyncJobObservation, 'phase' | 'stage' | 'step' | 'percent' | 'hasCleanupError'>,
  t: Translate,
): TaskPreview {
  const { phase, stage, step, percent, hasCleanupError } = observation
  const steps: TaskStepProgress = { current: step, percent }
  if (phase === 'running') {
    return { status: t(`task.stage.${stage}`), percent, phase, steps }
  }
  if (hasCleanupError) {
    return { status: t('task.cleanupFailed'), percent: null, phase: 'partial', steps }
  }
  const key = {
    done: 'task.done',
    partial: 'task.partial',
    failed: 'task.failed',
    cancelled: 'task.cancelled',
    unknown: 'task.unknown',
  } as const
  return { status: t(key[phase]), percent: phase === 'done' ? 100 : null, phase, steps }
}

/** 恢复任务可见状态；双端的既有摘要均可映射到此类型。 */
export type RestoreTaskStatus =
  'preparing' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** 恢复没有复制流程的五阶段，不推算百分比；清理错误优先提示。 */
export function restoreTaskPreview(
  status: RestoreTaskStatus,
  hasCleanupError: boolean,
  t: Translate,
): TaskPreview {
  const titles = {
    preparing: 'backup.status.preparing',
    ready: 'backup.status.ready',
    running: 'backup.status.running',
    succeeded: 'backup.restored',
    failed: 'backup.restoreFailed',
    cancelled: 'backup.restoreCancelled',
    unknown: 'task.unknown',
  } as const
  const phases = {
    preparing: 'running',
    ready: 'running',
    running: 'running',
    succeeded: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
    unknown: 'unknown',
  } as const
  return {
    status: t(hasCleanupError ? 'task.cleanupFailed' : titles[status]),
    percent: null,
    phase: hasCleanupError ? 'partial' : phases[status],
    steps: null,
  }
}

/** 旧版文件传输无项目绑定和完整五阶段；保留入口并只显示确知状态。 */
export function legacyTaskPreview(task: TransferTask, t: Translate): TaskPreview {
  const state = task.remote?.role === 'receiver' ? task.remote : task.local
  const isRunning = taskIsActive(task)
  const status = state?.status
  const phase: SyncTaskPhase = isRunning
    ? 'running'
    : status === 'succeeded'
      ? 'done'
      : status === 'failed'
        ? 'failed'
        : status === 'cancelled'
          ? 'cancelled'
          : 'unknown'
  const title = {
    running: 'game.transferRunning',
    done: 'task.done',
    failed: 'task.failed',
    cancelled: 'task.cancelled',
    unknown: 'task.unknown',
  } as const
  return { status: t(title[phase]), percent: null, phase, steps: null }
}
