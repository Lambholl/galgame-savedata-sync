import type { BatchManifest } from '../protocol/batch-contracts.ts'
import type { OperationError, TransferDirection } from '../protocol/contracts.ts'
import type { SyncProjectBinding } from '../library/project-binding.ts'
import type { SyncApplyResult, SyncPlan, SyncSnapshot } from './sync-contracts.ts'

/** 复制请求里标识发起设备的 HTTP 头。 */
export const SYNC_DEVICE_HEADER = 'x-sync-device-id'

/** 目标端项目的元数据，包括目标端本机的备份设置。 */
export interface SyncProjectDescriptor {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly deviceId: string
  readonly rootId: string
  readonly shouldBackup: boolean
  /** 目标端这个游戏目录实际生效的保留份数。 */
  readonly backupKeepCount: number
}

/** 复制任务的登记请求；jobId 等于 plan.planId。 */
export interface SyncJobRequest {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly sourceProjectId: string
  readonly targetProjectId: string
  readonly plan: SyncPlan
}

/**
 * 复制任务进度。前九个字段与 BatchProgress 相同；只有目录或计划为空时，文件数和归档字节可以为 0。
 */
export interface SyncJobProgress {
  readonly sourceBytesRead: number
  readonly archiveBytesTransferred: number
  readonly fileBytesVerified: number
  readonly fileBytesPublished: number
  readonly totalFileBytes: number
  readonly totalArchiveBytes: number | null
  readonly totalFiles: number
  readonly verifiedFiles: number
  readonly publishedFiles: number
  /** 接收端已复制进备份的字节数；发送端始终为 0。 */
  readonly backupBytesCopied: number
  /** 本次要备份的字节数，等于计划的 backupFileBytes，计划里为 null 时为 0。 */
  readonly totalBackupBytes: number
}

/** 任务状态的版本；2 起带 failureStage，3 起进度带备份字节数。 */
export const SYNC_JOB_SCHEMA_VERSION = 3

/** 任务的工作阶段；cleaning 和 done 是收尾阶段。 */
export type SyncFailureStage =
  | 'preparing'
  | 'ready'
  | 'awaiting-content'
  | 'transferring'
  | 'verifying'
  | 'backing-up'
  | 'writing'

/** 任务状态的摘要，不含逐项结果。 */
export interface SyncJobDigest {
  readonly schemaVersion: typeof SYNC_JOB_SCHEMA_VERSION
  readonly jobId: string
  readonly direction: TransferDirection
  readonly role: 'sender' | 'receiver'
  readonly status: 'running' | 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly stage: SyncFailureStage | 'cleaning' | 'done'
  readonly updatedAt: number
  readonly cancelRequested: boolean
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
  readonly direction: TransferDirection
  readonly status: 'preparing' | 'ready' | 'failed' | 'cancelled'
  readonly error: OperationError | null
}
/** 准备完成后的预览：两端快照和绑定，可以还原出计划。 */
export interface SyncPreparationPreview {
  readonly schemaVersion: 1
  readonly preparationId: string
  readonly direction: TransferDirection
  readonly binding: SyncProjectBinding
  readonly source: SyncSnapshot
  readonly target: SyncSnapshot
  readonly shouldBackup: boolean
  /** 开始前为 false；开始后是这次任务确认时的选择。 */
  readonly shouldDeleteExtras: boolean
  /** 被写入一端的保留份数，不分传输方向。 */
  readonly backupKeepCount: number
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

/** 复制任务的清单；计划里没有文件时为 null。 */
export type SyncJobManifest = BatchManifest | null
