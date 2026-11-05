import type { BatchManifest } from '../protocol/batch-contracts.ts'
import type { OperationError, TransferDirection } from '../protocol/contracts.ts'
import type { SyncProjectBinding } from '../library/project-binding.ts'
import type { SyncApplyResult, SyncPlan, SyncSnapshot } from './sync-contracts.ts'

/** 复制请求里标识设备的 HTTP 头，用在目录表已建立的连接上；身份核对还要看会话和保存的项目关联。 */
export const SYNC_DEVICE_HEADER = 'x-sync-device-id'

/** 目标端项目的只读元数据；备份开关由目标端本机设置，复制请求不能远程修改。 */
export interface SyncProjectDescriptor {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly deviceId: string
  readonly rootId: string
  readonly shouldBackup: boolean
  /** 目标端这个游戏目录实际生效的保留份数。 */
  readonly backupKeepCount: number
}

/** 复制任务的登记请求：先登记确认的计划，来源准备好归档后再 PUT 一次清单；jobId 等于 plan.planId。 */
export interface SyncJobRequest {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly sourceProjectId: string
  readonly targetProjectId: string
  readonly plan: SyncPlan
}

/** 复制任务进度，字段与 BatchProgress 一致；校验单独进行，允许只有目录或空计划时零文件、零归档。 */
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
}

/** 任务状态的版本；2 起带 failureStage。 */
export const SYNC_JOB_SCHEMA_VERSION = 2

/** 任务工作阶段；cleaning 和 done 是收尾，不算错误发生的位置。 */
export type SyncFailureStage =
  | 'preparing'
  | 'ready'
  | 'awaiting-content'
  | 'transferring'
  | 'verifying'
  | 'backing-up'
  | 'writing'

/** sync.job 事件推送的有界摘要：任务状态去掉逐项结果，结果另用 sync.job.read 读取。 */
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
   * 任务中断时所处的工作阶段，清理和终态更新不会改写它。只有 failed、unknown、cancelled
   * 才可能有值；在收尾时才出错或没有经过任何工作阶段时为 null，表示没有记录。
   */
  readonly failureStage: SyncFailureStage | null
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}

/** 本端角色的任务状态：发送端的 sent 不表示目标写入成功，接收端带实际结果。 */
export interface SyncJobState extends SyncJobDigest {
  readonly result: SyncApplyResult | null
}

/** 准备阶段（只读扫描）的状态，不需要传输通知；确认输入和完整结果分开查询，以遵守控制 JSON 的大小上限。 */
export interface SyncPreparationState {
  readonly schemaVersion: 1
  readonly preparationId: string
  readonly direction: TransferDirection
  readonly status: 'preparing' | 'ready' | 'failed' | 'cancelled'
  readonly error: OperationError | null
}
export interface SyncPreparationPreview {
  readonly schemaVersion: 1
  readonly preparationId: string
  readonly direction: TransferDirection
  readonly binding: SyncProjectBinding
  readonly source: SyncSnapshot
  readonly target: SyncSnapshot
  readonly shouldBackup: boolean
  /** 开始前为 false，由页面按开关决定；开始后是这次任务确认的选择，读回时据此还原计划。 */
  readonly shouldDeleteExtras: boolean
  /** 被写入一端的保留份数，不分传输方向。 */
  readonly backupKeepCount: number
}

/**
 * 一次传输两个角色各自的状态，两端查询任务都返回它。
 * remote 为 null 表示还没收到对端状态；remoteError 表示读到的 remote 已不可信，结果待确认。
 */
export interface SyncTransferState {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly local: SyncJobState
  readonly remote: SyncJobState | null
  readonly remoteError: OperationError | null
}

/** 空计划没有归档；有文件时按源快照核对已准备清单。 */
export type SyncJobManifest = BatchManifest | null
