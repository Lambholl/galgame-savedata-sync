import type { Translate } from '../../i18n/translate.ts'
import type { SyncJobObservation, SyncTaskPhase } from '../../sync/sync-job-observation.ts'
import type { TransferTask } from '../../transfer/transfer.ts'
import { taskIsActive } from '../../transfer/transfer.ts'

/** 三段进度的本地化键。 */
export const SYNC_TASK_STEPS = [
  'task.step.transfer',
  'task.step.backup',
  'task.step.write',
] as const

/** 编号步骤条所需的数据。 */
export interface TaskStepProgress {
  /** 零起点阶段，等于步骤数时表示全部完成；null 表示阶段未记录。 */
  readonly current: number | null
  /** 当前阶段的完成百分比，未知时使用起始刻度。 */
  readonly percent: number | null
}

/** 任务的短状态。 */
export interface TaskPreview {
  /** 本地化后的当前阶段或结果。 */
  readonly status: string
  /** 当前阶段百分比；缺少计数或接收端结果时为 null。 */
  readonly percent: number | null
  /** 决定图标与语义色的任务状态。 */
  readonly phase: SyncTaskPhase
  /** 复制任务的三段步骤；恢复和批量传输用 null。 */
  readonly steps: TaskStepProgress | null
}

/**
 * 由复制任务的观察结果生成短状态。清理失败时 status 写清理失败：传输成功时只写清理失败、phase 为 partial，
 * 其他结论后面接着写清理失败、phase 不变。
 */
export function syncTaskPreview(
  observation: Pick<
    SyncJobObservation,
    'phase' | 'stage' | 'step' | 'percent' | 'hasCleanupError'
  > & {
    /** 已经确认、对方设备还没开始；进行中时 status 写等待对方开始。 */
    readonly isAwaitingPeer?: boolean
  },
  t: Translate,
): TaskPreview {
  const { phase, stage, step, percent, hasCleanupError, isAwaitingPeer = false } = observation
  const steps: TaskStepProgress = { current: step, percent }
  if (phase === 'running') {
    return {
      status: t(isAwaitingPeer ? 'task.awaitingPeer' : `task.stage.${stage}`),
      percent,
      phase,
      steps,
    }
  }
  if (hasCleanupError && phase === 'done') {
    return { status: t('task.cleanupFailed'), percent: null, phase: 'partial', steps }
  }
  const key = {
    done: 'task.done',
    partial: 'task.partial',
    failed: 'task.failed',
    cancelled: 'task.cancelled',
    unknown: 'task.unknown',
  } as const
  return {
    status: withCleanupFailure(t(key[phase]), hasCleanupError, t),
    percent: phase === 'done' ? 100 : null,
    phase,
    steps,
  }
}

// 传输失败又清理失败时只写清理失败，会让人以为传输本身成功了。
function withCleanupFailure(status: string, hasCleanupError: boolean, t: Translate): string {
  return hasCleanupError ? `${status} · ${t('task.cleanupFailed')}` : status
}

/** 恢复任务的状态。 */
export type RestoreTaskStatus =
  'preparing' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** 由恢复任务的状态生成短状态；steps 和 percent 为 null，清理失败的写法同 {@link syncTaskPreview}。 */
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
  if (hasCleanupError && phases[status] === 'done') {
    return { status: t('task.cleanupFailed'), percent: null, phase: 'partial', steps: null }
  }
  return {
    status: withCleanupFailure(t(titles[status]), hasCleanupError, t),
    percent: null,
    phase: phases[status],
    steps: null,
  }
}

/** 由批量传输任务生成短状态；steps 和 percent 为 null。 */
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
