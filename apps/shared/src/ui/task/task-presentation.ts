import type { MessageKey } from '../../i18n/messages.ts'
import type { Translate } from '../../i18n/translate.ts'
import type { SyncJobObservation, SyncTaskPhase } from '../../sync/sync-job-observation.ts'
import type { SyncRestoreObservation } from '../../sync/sync-restore-observation.ts'

/** 复制任务三段进度的本地化键。 */
export const SYNC_TASK_STEPS = [
  'task.step.backup',
  'task.step.transfer',
  'task.step.write',
] as const

/** 不备份的复制任务两段进度的本地化键。 */
export const SYNC_TASK_STEPS_WITHOUT_BACKUP = ['task.step.transfer', 'task.step.write'] as const

/** 恢复任务两段进度的本地化键。 */
export const RESTORE_TASK_STEPS = ['task.step.backup', 'task.step.write'] as const

/**
 * 把复制任务观察结果里的三段 step 换成要显示的步骤。
 *
 * @param step 观察结果的 step，按备份、传输、写入三段计数。
 * @param shouldBackup 计划是否在写入前备份；为 false 时去掉备份段，原备份段算作传输段。
 */
export function syncTaskSteps(
  step: number | null,
  shouldBackup: boolean,
): { readonly current: number | null; readonly labels: readonly MessageKey[] } {
  if (shouldBackup) {
    return { current: step, labels: SYNC_TASK_STEPS }
  }
  // 不备份时准备阶段也落在第 0 段，并到传输段里显示。
  return {
    current: step === null ? null : Math.max(0, step - 1),
    labels: SYNC_TASK_STEPS_WITHOUT_BACKUP,
  }
}

/**
 * 进行中的复制任务的阶段名。
 *
 * @param shouldBackup 计划是否在写入前备份；为 false 时 backing-up 显示为准备。
 */
export function syncStageLabel(
  stage: SyncJobObservation['stage'],
  shouldBackup: boolean,
): MessageKey {
  // 接收端不备份时也经过 backing-up：写入前在这一阶段核对目标。
  return stage === 'backing-up' && !shouldBackup ? 'task.stage.preparing' : `task.stage.${stage}`
}

/** 编号步骤条所需的数据。 */
export interface TaskStepProgress {
  /** 零起点阶段，等于步骤数时表示全部完成；null 表示阶段未记录。 */
  readonly current: number | null
  /** 当前阶段的完成百分比，未知时使用起始刻度。 */
  readonly percent: number | null
  /** 各阶段的本地化键；省略时使用 {@link SYNC_TASK_STEPS}。 */
  readonly labels?: readonly MessageKey[]
}

/** 任务的短状态。 */
export interface TaskPreview {
  /** 本地化后的当前阶段或结果。 */
  readonly status: string
  /** 当前阶段百分比；缺少计数或接收端结果时为 null。 */
  readonly percent: number | null
  /** 决定图标与语义色的任务状态。 */
  readonly phase: SyncTaskPhase
  /** 各阶段进度；没有步骤条时为 null。 */
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
    /** 计划是否在写入前备份；为 false 时 steps 不含备份段。 */
    readonly shouldBackup: boolean
  },
  t: Translate,
): TaskPreview {
  const { phase, stage, step, percent, hasCleanupError, isAwaitingPeer = false } = observation
  const steps: TaskStepProgress = { ...syncTaskSteps(step, observation.shouldBackup), percent }
  if (phase === 'running') {
    return {
      status: t(
        isAwaitingPeer ? 'task.awaitingPeer' : syncStageLabel(stage, observation.shouldBackup),
      ),
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

/** 由恢复任务的观察结果生成短状态；清理失败的写法同 {@link syncTaskPreview}。 */
export function restoreObservationPreview(
  observation: Pick<
    SyncRestoreObservation,
    'phase' | 'stage' | 'step' | 'percent' | 'hasCleanupError'
  >,
  t: Translate,
): TaskPreview {
  const { phase, stage, step, percent, hasCleanupError } = observation
  const steps: TaskStepProgress = { current: step, percent, labels: RESTORE_TASK_STEPS }
  if (phase === 'running') {
    return {
      status: stage === 'ready' ? t('backup.status.ready') : t(`task.stage.${stage}`),
      percent,
      phase,
      steps,
    }
  }
  if (hasCleanupError && phase === 'done') {
    return { status: t('task.cleanupFailed'), percent: null, phase: 'partial', steps }
  }
  const key = {
    done: 'backup.restored',
    partial: 'task.partial',
    failed: 'backup.restoreFailed',
    cancelled: 'backup.restoreCancelled',
    unknown: 'backup.restoreUnknown',
  } as const
  return {
    status: withCleanupFailure(t(key[phase]), hasCleanupError, t),
    percent: phase === 'done' ? 100 : null,
    phase,
    steps,
  }
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
