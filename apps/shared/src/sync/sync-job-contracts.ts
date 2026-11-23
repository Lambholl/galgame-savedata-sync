import type { OperationError } from '../protocol/contracts.ts'
import type { SyncProjectBinding } from '../library/project-binding.ts'
import type { SyncApplyResult, SyncDirection, SyncPlan, SyncSnapshot } from './sync-contracts.ts'

/** 复制请求里标识发起设备的 HTTP 头。 */
export const SYNC_DEVICE_HEADER = 'x-sync-device-id'

/** 对端项目的元数据。 */
export interface SyncProjectDescriptor {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly deviceId: string
  readonly rootId: string
}

/** 复制任务的登记请求；jobId 等于 plan.planId。 */
export interface SyncJobRequest {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly sourceProjectId: string
  readonly targetProjectId: string
  readonly plan: SyncPlan
}

/** 复制任务进度。只有计划里没有要传的文件时，文件数和字节数可以为 0。 */
export interface SyncJobProgress {
  /** 已打包或已解包的文件内容字节数，不含 tar 头和压缩开销。 */
  readonly transferredBytes: number
  readonly totalFileBytes: number
  readonly totalFiles: number
  /** 接收端已写入目标的文件数；发送端始终为 0。 */
  readonly publishedFiles: number
  /** 接收端已写入目标的字节数；发送端始终为 0。 */
  readonly fileBytesPublished: number
  /** 接收端已复制进备份的字节数；发送端始终为 0。 */
  readonly backupBytesCopied: number
  /** 本次要备份的字节数，等于计划的 backupFileBytes，计划里为 null 时为 0。 */
  readonly totalBackupBytes: number
}

/** 任务状态结构的版本。 */
export const SYNC_JOB_SCHEMA_VERSION = 5

/** 任务的工作阶段；cleaning 和 done 是收尾阶段。 */
export type SyncFailureStage =
  'preparing' | 'ready' | 'awaiting-content' | 'transferring' | 'backing-up' | 'writing'

/** 任务状态的摘要，不含逐项结果。 */
export interface SyncJobDigest {
  readonly schemaVersion: typeof SYNC_JOB_SCHEMA_VERSION
  readonly jobId: string
  readonly direction: SyncDirection
  readonly role: 'sender' | 'receiver'
  readonly status: 'running' | 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly stage: SyncFailureStage | 'cleaning' | 'done'
  readonly updatedAt: number
  readonly isCancelRequested: boolean
  readonly progress: SyncJobProgress
  /**
   * 任务中断时所处的工作阶段，记录后保持不变。只在 failed、unknown、cancelled 时可能有值；
   * 在收尾阶段出错或还没进入工作阶段时为 null。
   */
  readonly failureStage: SyncFailureStage | null
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}

/** 本端角色的任务状态：发送端的 sent 表示本机发送完成，接收端带实际写入结果。 */
export interface SyncJobState extends SyncJobDigest {
  readonly result: SyncApplyResult | null
}

/** 准备阶段（只读扫描）的状态。 */
export interface SyncPreparationState {
  readonly schemaVersion: 1
  readonly preparationId: string
  readonly direction: SyncDirection
  readonly status: 'preparing' | 'ready' | 'failed' | 'cancelled'
  readonly error: OperationError | null
}
/** 准备完成后的预览：两端快照和绑定，可以还原出计划。 */
export interface SyncPreparationPreview {
  readonly schemaVersion: 1
  /** 还原出的计划的 planId，开始后也是任务 ID。 */
  readonly preparationId: string
  readonly direction: SyncDirection
  /** 本机在这次传输里是监听方还是拨号方；binding 的 local 一侧就是这一端。 */
  readonly localSide: 'listener' | 'dialer'
  readonly binding: SyncProjectBinding
  readonly source: SyncSnapshot
  readonly target: SyncSnapshot
  readonly shouldBackup: boolean
  /** 开始前为 false；开始后是这次任务确认时的选择。 */
  readonly shouldDeleteExtras: boolean
}

/**
 * 一次传输中两个角色各自的状态。
 * remote 为 null 表示还没收到对端状态；remoteError 非空表示 remote 已失效，结果待确认。
 */
export interface SyncTransferState {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly local: SyncJobState
  readonly remote: SyncJobState | null
  readonly remoteError: OperationError | null
}
