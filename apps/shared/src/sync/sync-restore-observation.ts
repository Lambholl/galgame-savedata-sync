import type {
  SyncApplyResult,
  SyncRestoreFailureStage,
  SyncRestoreProgress,
  SyncRestoreStage,
  SyncRestoreStatus,
} from './sync-contracts.ts'
import type { SyncJobCounters, SyncTaskPhase } from './sync-job-observation.ts'

/** 恢复两段流程（备份、写入）全部完成时的 step。 */
export const RESTORE_STEP_DONE = 2

/** 观察本机恢复任务所需的输入。 */
export interface SyncRestoreObservationInput {
  readonly status: SyncRestoreStatus
  readonly stage: SyncRestoreStage
  readonly failureStage: SyncRestoreFailureStage | null
  readonly progress: SyncRestoreProgress
  readonly result: SyncApplyResult | null
  readonly cleanupError: unknown
}

/** 由本机恢复状态合成的任务观察结果。 */
export interface SyncRestoreObservation {
  readonly phase: SyncTaskPhase
  /** 进行中是当前阶段，结束后为 done。 */
  readonly stage: SyncRestoreStage
  /** 两段流程（备份、写入）的零起点索引，{@link RESTORE_STEP_DONE} 表示全部完成；null 表示没有记录到具体位置。 */
  readonly step: number | null
  /** 当前段的完成百分比；缺少计数时为 null。 */
  readonly percent: number | null
  /** 任务中断时所处的阶段；没有记录时为 null。 */
  readonly failureStage: SyncRestoreFailureStage | null
  readonly counters: SyncJobCounters
  readonly hasCleanupError: boolean
}

const STEP_OF: Readonly<Record<SyncRestoreStage, number>> = {
  preparing: 0,
  ready: 0,
  verifying: 0,
  'backing-up': 0,
  writing: 1,
  cleaning: RESTORE_STEP_DONE,
  done: RESTORE_STEP_DONE,
}

function ratio(done: number, total: number | null): number | null {
  return total ? Math.min(1, Math.max(0, done / total)) : null
}

/** 由本机恢复任务的状态与进度合成统一的观察结果。 */
export function observeRestoreTask(input: SyncRestoreObservationInput): SyncRestoreObservation {
  const outcomes = input.result?.outcomes ?? []
  const isRunning =
    input.status === 'preparing' || input.status === 'ready' || input.status === 'running'
  let phase: SyncTaskPhase
  if (isRunning) {
    phase = 'running'
  } else if (
    input.status === 'succeeded' &&
    !input.result?.error &&
    outcomes.every((item) => item.status === 'succeeded')
  ) {
    phase = 'done'
  } else if (input.status === 'unknown') {
    phase = 'unknown'
  } else if (outcomes.some((item) => item.status === 'succeeded')) {
    phase = 'partial'
  } else if (input.status === 'cancelled') {
    phase = 'cancelled'
  } else {
    phase = 'failed'
  }

  const stage: SyncRestoreStage = isRunning ? input.stage : 'done'
  let step: number | null = null
  if (phase === 'done') {
    step = RESTORE_STEP_DONE
  } else if (phase === 'running') {
    step = STEP_OF[stage]
  } else if (phase !== 'cancelled') {
    step = input.failureStage ? STEP_OF[input.failureStage] : null
  }

  const { progress } = input
  const counters: SyncJobCounters =
    step === 0
      ? {
          completedFiles: null,
          totalFiles: progress.totalFiles,
          completedBytes: progress.backupBytesCopied,
          totalBytes: progress.totalBackupBytes,
        }
      : {
          completedFiles: step === 1 ? progress.publishedFiles : null,
          totalFiles: progress.totalFiles,
          completedBytes: progress.fileBytesPublished,
          totalBytes: progress.totalFileBytes,
        }

  const fraction =
    step === 0
      ? stage === 'backing-up'
        ? ratio(counters.completedBytes, counters.totalBytes)
        : null
      : step === 1
        ? (ratio(counters.completedBytes, counters.totalBytes) ??
          ratio(progress.publishedFiles, progress.totalFiles))
        : null

  return {
    phase,
    stage,
    step,
    percent: phase === 'done' ? 100 : fraction === null ? null : Math.round(fraction * 100),
    failureStage: input.failureStage,
    counters,
    hasCleanupError: Boolean(input.cleanupError || input.result?.cleanupError),
  }
}
