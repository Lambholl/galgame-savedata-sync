import type { SyncJobState } from '../../sync/sync-job-contracts.ts'
import type { Translate } from '../../i18n/translate.ts'
import { unsettledOutcomes } from './outcomes.ts'
import type { TransferTask } from '../../transfer/transfer.ts'
import { taskIsActive } from '../../transfer/transfer.ts'

/** 任务展示所用的状态；成功依据接收端实际结果。 */
export type SyncTaskPhase = 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'unknown'

/** 五段进度的本地化键。 */
export const SYNC_TASK_STEPS = [
  'task.step.pack',
  'task.step.transfer',
  'task.step.verify',
  'task.step.backup',
  'task.step.write',
] as const

const STEP_OF: Readonly<Record<SyncJobState['stage'], number>> = {
  preparing: 0,
  ready: 1,
  'awaiting-content': 1,
  transferring: 1,
  verifying: 2,
  'backing-up': 3,
  writing: 4,
  cleaning: 5,
  done: 5,
}

/** 详情与列表共用的阶段及当前阶段进度，不估算总耗时百分比。 */
export interface SyncTaskPresentation {
  /** 按接收端结果判定的总体状态。 */
  readonly phase: SyncTaskPhase
  /** 用于展示进度的一端，优先接收端。 */
  readonly leading: SyncJobState
  /** 当前阶段的零起点索引，5 表示全部完成，null 表示失败阶段未记录。 */
  readonly step: number | null
  /** 当前阶段的完成百分比；备份、清理等缺少计数时为 null。 */
  readonly percent: number | null
}

function ratio(done: number, total: number | null): number | null {
  return total ? Math.min(1, Math.max(0, done / total)) : null
}

/** 两端状态映射为同一套展示信息；failureStage 由后续任务观察接口提供，缺少时不推测失败位置。 */
export function presentSyncTask(
  local: SyncJobState,
  remote: SyncJobState | null,
  failureStage: SyncJobState['stage'] | null = null,
): SyncTaskPresentation {
  const receiver = local.role === 'receiver' ? local : remote?.role === 'receiver' ? remote : null
  const states = remote ? [local, remote] : [local]
  const result = receiver?.result ?? null
  const outcomes = result?.outcomes ?? []
  let phase: SyncTaskPhase
  if (states.some((item) => item.status === 'running')) {
    phase = 'running'
  } else if (result) {
    const succeeded = outcomes.filter((item) => item.status === 'succeeded').length
    phase =
      result.error && succeeded === 0
        ? 'failed'
        : result.error || unsettledOutcomes(outcomes).length > 0
          ? 'partial'
          : 'done'
  } else if (states.some((item) => item.status === 'cancelled')) {
    phase = 'cancelled'
  } else if (states.some((item) => item.status === 'failed')) {
    phase = 'failed'
  } else {
    phase = 'unknown'
  }
  const leading = receiver ?? local
  // 当前协议把所有终态阶段都改成 done；没有独立的失败阶段，无法知道哪一步出错，所以不标红最后一步。
  const failedStage = failureStage ?? (leading.stage === 'done' ? null : leading.stage)
  const step =
    phase === 'done'
      ? 5
      : phase === 'failed' || phase === 'partial'
        ? failedStage && failedStage !== 'done' && failedStage !== 'cleaning'
          ? STEP_OF[failedStage]
          : null
        : phase === 'running'
          ? STEP_OF[leading.stage]
          : local.status === 'sent' && !receiver
            ? 2
            : null
  const progress = leading.progress
  const fraction =
    step === 0
      ? ratio(progress.sourceBytesRead, progress.totalFileBytes)
      : step === 1
        ? ratio(progress.archiveBytesTransferred, progress.totalArchiveBytes)
        : step === 2
          ? (ratio(progress.fileBytesVerified, progress.totalFileBytes) ??
            ratio(progress.verifiedFiles, progress.totalFiles))
          : step === 4
            ? (ratio(progress.fileBytesPublished, progress.totalFileBytes) ??
              ratio(progress.publishedFiles, progress.totalFiles))
            : null
  return {
    phase,
    leading,
    step,
    percent: phase === 'done' ? 100 : fraction === null ? null : Math.round(fraction * 100),
  }
}

/** 编号步骤条所需的数据；失败阶段可由后续任务观察接口提供。 */
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

/** 完整结果读取前先显示摘要；即使状态为 succeeded，也要等逐项结果才能判定全部或部分完成。 */
export function syncSummaryPreview(
  state: Pick<SyncJobState, 'status' | 'stage'>,
  hasCleanupError: boolean,
  t: Translate,
): TaskPreview {
  const phase: SyncTaskPhase = hasCleanupError
    ? 'partial'
    : state.status === 'running'
      ? 'running'
      : state.status === 'failed'
        ? 'failed'
        : state.status === 'cancelled'
          ? 'cancelled'
          : 'unknown'
  const titles = {
    sent: 'task.sent',
    succeeded: 'task.loading',
    failed: 'task.failed',
    cancelled: 'task.cancelled',
    unknown: 'task.unknown',
  } as const
  const status = hasCleanupError
    ? t('task.cleanupFailed')
    : state.status === 'running'
      ? t(`task.stage.${state.stage}`)
      : t(titles[state.status])
  return {
    status,
    phase,
    percent: null,
    steps: {
      current:
        state.status === 'running' ? STEP_OF[state.stage] : state.status === 'sent' ? 2 : null,
      percent: null,
    },
  }
}

/** 只用已读取的任务状态生成摘要，不把发送完成当作目标写入成功。 */
export function syncTaskPreview(
  local: SyncJobState,
  remote: SyncJobState | null,
  t: Translate,
  failureStage: SyncJobState['stage'] | null = null,
): TaskPreview {
  const shown = presentSyncTask(local, remote, failureStage)
  const steps: TaskStepProgress = { current: shown.step, percent: shown.percent }
  if (shown.phase === 'running') {
    return {
      status: t(`task.stage.${shown.leading.stage}`),
      percent: shown.percent,
      phase: shown.phase,
      steps,
    }
  }
  if (shown.leading.cleanupError || shown.leading.result?.cleanupError || local.cleanupError) {
    return { status: t('task.cleanupFailed'), percent: null, phase: 'partial', steps }
  }
  const key = {
    done: 'task.done',
    partial: 'task.partial',
    failed: 'task.failed',
    cancelled: 'task.cancelled',
    unknown: local.status === 'sent' ? 'task.sent' : 'task.unknown',
  } as const
  return {
    status: t(key[shown.phase]),
    percent: shown.phase === 'done' ? 100 : null,
    phase: shown.phase,
    steps,
  }
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
