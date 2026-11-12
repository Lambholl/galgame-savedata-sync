import type { OperationErrorCode, TransferDirection } from '../protocol/contracts.ts'
import type { ShownError } from '../result.ts'
import type { SyncFailureStage, SyncJobState } from './sync-job-contracts.ts'

// Android 的 SyncTransferEngine.DEVICE_ERRORS 是同一份清单，两边要一起改。
/** 能归到某一端的错误码，都是文件和目录访问失败。 */
const DEVICE_ERRORS: ReadonlySet<OperationErrorCode> = new Set<OperationErrorCode>([
  'authorization-expired',
  'permission-denied',
  'not-found',
  'not-readable',
  'unsupported-operation',
  'name-conflict',
  'path-outside-root',
  'insufficient-space',
  'io-failure',
])

/**
 * 按任务中断的阶段给错误标出所在的一端：打包阶段是来源，校验、备份和写入阶段是目标。
 *
 * @returns 错误已带 device、错误码与文件访问无关、打包阶段的授权失效或处于其他阶段时，返回原错误。
 */
export function locateSyncError(
  error: ShownError,
  direction: TransferDirection,
  failureStage: SyncFailureStage | null,
): ShownError {
  if (error.device !== undefined || error.code === null || !DEVICE_ERRORS.has(error.code)) {
    return error
  }
  const [source, target] =
    direction === 'windows-to-android' ? (['pc', 'phone'] as const) : (['phone', 'pc'] as const)
  if (failureStage === 'preparing' && error.code !== 'authorization-expired') {
    return { ...error, device: source }
  }
  if (failureStage === 'verifying' || failureStage === 'backing-up' || failureStage === 'writing') {
    return { ...error, device: target }
  }
  return error
}

/** 一次传输的总体状态，按接收端的实际结果判断成功。 */
export type SyncTaskPhase = 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'unknown'

/** 当前阶段的计数；不适用或还不知道的项为 null。 */
export interface SyncJobCounters {
  /** 校验和写入阶段已完成的文件数，其他阶段为 null。 */
  readonly completedFiles: number | null
  readonly totalFiles: number
  readonly completedBytes: number
  /** 传输阶段是压缩体总量，清单出来之前为 null；备份阶段是本次要备份的字节数。 */
  readonly totalBytes: number | null
}

/** 由两个角色的状态合成的任务结论。 */
export interface SyncJobObservation {
  readonly phase: SyncTaskPhase
  /** 进行中是走在最前面的阶段，结束后是 done。 */
  readonly stage: SyncJobState['stage']
  /** 五段流程的零起点索引，5 表示全部完成；null 表示没有记录到具体位置。 */
  readonly step: number | null
  /** 当前段的完成百分比；缺少计数时为 null。 */
  readonly percent: number | null
  /** 任务中断时所处的阶段；没有记录时为 null。 */
  readonly failureStage: SyncFailureStage | null
  readonly counters: SyncJobCounters
  readonly hasCleanupError: boolean
}

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

function ratio(done: number, total: number | null): number | null {
  return total ? Math.min(1, Math.max(0, done / total)) : null
}

/** 两端都在跑时取走得更远的一端；发送端在收尾时以接收端为准。 */
function runningStage(
  sender: SyncJobState | null,
  receiver: SyncJobState | null,
): SyncJobState['stage'] {
  const isSenderRunning = sender?.status === 'running'
  if (receiver?.status === 'running') {
    return isSenderRunning &&
      sender.stage !== 'cleaning' &&
      STEP_OF[sender.stage] > STEP_OF[receiver.stage]
      ? sender.stage
      : receiver.stage
  }
  // 发送端已结束、还没收到接收端状态时，下一步就是接收端校验。
  return isSenderRunning ? sender.stage : 'verifying'
}

function terminalPhase(
  local: SyncJobState,
  remote: SyncJobState | null,
  sender: SyncJobState | null,
  receiver: SyncJobState | null,
): SyncTaskPhase {
  const states = remote ? [local, remote] : [local]
  const outcomes = receiver?.result?.outcomes ?? []
  if (receiver?.status === 'succeeded') {
    return 'done'
  }
  if (outcomes.some((item) => item.status === 'succeeded')) {
    return 'partial'
  }
  if (states.some((item) => item.status === 'unknown')) {
    return 'unknown'
  }
  if (receiver?.status === 'failed' || sender?.status === 'failed') {
    return 'failed'
  }
  return states.some((item) => item.status === 'cancelled') ? 'cancelled' : 'unknown'
}

/**
 * 合成两个角色的状态。
 *
 * @param hasRemoteError 为 true 时 remote 按失效处理，本机结束后结论为 unknown。
 */
export function observeSyncJob(
  local: SyncJobState,
  remote: SyncJobState | null,
  hasRemoteError: boolean,
): SyncJobObservation {
  const sender = local.role === 'sender' ? local : remote
  const receiver = local.role === 'receiver' ? local : remote
  const isRunning =
    local.status === 'running' ||
    (!hasRemoteError && (remote?.status === 'running' || (local.status === 'sent' && !remote)))
  const phase = isRunning ? 'running' : terminalPhase(local, remote, sender, receiver)
  const stage = isRunning ? runningStage(sender, receiver) : 'done'
  const failed = [receiver, sender].find((item) => item?.status === 'failed')
  const failureStage =
    failed?.failureStage ?? receiver?.failureStage ?? sender?.failureStage ?? null
  let step: number | null = null
  if (phase === 'done') {
    step = 5
  } else if (phase === 'running') {
    step = STEP_OF[stage]
  } else if (phase !== 'cancelled') {
    // 内容已发完但结果没回来时，停在接收端的校验这一步。
    step = failureStage
      ? STEP_OF[failureStage]
      : phase === 'unknown' && sender?.status === 'sent'
        ? 2
        : null
  }
  const totals = (receiver ?? local).progress
  const archived = Math.max(
    local.progress.archiveBytesTransferred,
    remote?.progress.archiveBytesTransferred ?? 0,
  )
  const archiveTotal =
    local.progress.totalArchiveBytes ?? remote?.progress.totalArchiveBytes ?? null
  const counters: SyncJobCounters =
    step === 0
      ? {
          completedFiles: null,
          totalFiles: totals.totalFiles,
          completedBytes: sender?.progress.sourceBytesRead ?? 0,
          totalBytes: totals.totalFileBytes,
        }
      : step === 1
        ? {
            completedFiles: null,
            totalFiles: totals.totalFiles,
            completedBytes: archived,
            totalBytes: archiveTotal,
          }
        : step === 2
          ? {
              completedFiles: totals.verifiedFiles,
              totalFiles: totals.totalFiles,
              completedBytes: totals.fileBytesVerified,
              totalBytes: totals.totalFileBytes,
            }
          : step === 3
            ? {
                completedFiles: null,
                totalFiles: totals.totalFiles,
                completedBytes: totals.backupBytesCopied,
                totalBytes: totals.totalBackupBytes,
              }
            : {
                completedFiles: step === 4 ? totals.publishedFiles : null,
                totalFiles: totals.totalFiles,
                completedBytes: totals.fileBytesPublished,
                totalBytes: totals.totalFileBytes,
              }
  // 打包进度只有发送端知道，还没收到时按未知处理，避免显示成 0%。
  const fraction =
    step === 0 && !sender
      ? null
      : step === 0 || step === 1 || step === 3
        ? ratio(counters.completedBytes, counters.totalBytes)
        : step === 2
          ? (ratio(counters.completedBytes, counters.totalBytes) ??
            ratio(totals.verifiedFiles, totals.totalFiles))
          : step === 4
            ? (ratio(counters.completedBytes, counters.totalBytes) ??
              ratio(totals.publishedFiles, totals.totalFiles))
            : null
  return {
    phase,
    stage,
    step,
    percent: phase === 'done' ? 100 : fraction === null ? null : Math.round(fraction * 100),
    failureStage,
    counters,
    hasCleanupError: Boolean(
      local.cleanupError || remote?.cleanupError || receiver?.result?.cleanupError,
    ),
  }
}
