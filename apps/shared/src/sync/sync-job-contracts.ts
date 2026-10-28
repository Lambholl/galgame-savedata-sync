import type { BatchManifest } from '../protocol/batch-contracts.ts'
import type { OperationError, TransferDirection } from '../protocol/contracts.ts'
import type { SyncProjectBinding } from '../library/project-binding.ts'
import type { SyncApplyResult, SyncPlan, SyncSnapshot } from './sync-contracts.ts'

/** 新同步请求标记既有目录表连接中的设备，身份核对仍同时依赖会话和保存的项目关联。 */
export const SYNC_DEVICE_HEADER = 'x-sync-device-id'

/** 目标端只读项目元数据；备份开关由目标端本机设置，不通过复制请求远程修改。 */
export interface SyncProjectDescriptor {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly deviceId: string
  readonly rootId: string
  readonly shouldBackup: boolean
}

/** 先登记确认计划，源准备归档后再单次 PUT 清单；jobId 固定为 plan.planId。 */
export interface SyncJobRequest {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly sourceProjectId: string
  readonly targetProjectId: string
  readonly plan: SyncPlan
}

/** 与旧 BatchProgress 字段一致，独立守卫允许仅目录/空计划的零文件及零归档分支。 */
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

/** 任务状态只报告本端角色；sender sent 不表示目标写入成功，receiver 携带实际结果。 */
export interface SyncJobState {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly direction: TransferDirection
  readonly role: 'sender' | 'receiver'
  readonly status: 'running' | 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly stage:
    | 'preparing'
    | 'awaiting-content'
    | 'transferring'
    | 'verifying'
    | 'backing-up'
    | 'writing'
    | 'cleaning'
    | 'done'
  readonly updatedAt: number
  readonly cancelRequested: boolean
  readonly progress: SyncJobProgress
  readonly result: SyncApplyResult | null
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}

/** 普通只读准备，不申请传输保活；确认输入和完整结果分开查询以遵守控制 JSON 限额。 */
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
}

/** 原生客户端保留两个角色的独立状态；远端不可查询时不伪造成功或重放写入。 */
export interface SyncTransferState {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly local: SyncJobState
  readonly remote: SyncJobState | null
  readonly remoteError: OperationError | null
}

/** 空计划没有归档；有文件时按源快照核对已准备清单。 */
export type SyncJobManifest = BatchManifest | null
