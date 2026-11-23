import type { CapabilityState, OperationError } from '../protocol/contracts.ts'

/** 复制功能的 schema 版本，与 PROTOCOL_VERSION 分别计数。 */
export const SYNC_SCHEMA_VERSION = 1
/**
 * 能力声明的版本，两端相同才能互传。
 */
export const SYNC_CAPABILITIES_VERSION = 8

/** 复制方向，按连接里的角色区分：listener-to-dialer 从监听方复制到拨号方。 */
export type SyncDirection = 'listener-to-dialer' | 'dialer-to-listener'

/** 两端修改日期相差不超过这个毫秒数时算相同，兼容 FAT 和 exFAT 的 2 秒精度。 */
export const SYNC_MODIFIED_TOLERANCE_MS = 2000

/** 单次扫描的上限。 */
export const SYNC_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxDepth: 64,
  maxPathLength: 4096,
  maxNameLength: 255,
  maxRetainedScans: 32,
  snapshotLifetimeMs: 600000,
  scanTimeoutMs: 1800000,
} as const)

/** 复制功能的 HTTP 路由。 */
export const SYNC_HTTP_ROUTES = {
  capabilities: '/v1/sync/capabilities',
  scans: '/v1/sync/scans',
  scan: '/v1/sync/scans/{scanId}',
  project: '/v1/sync/projects/{projectId}',
  jobs: '/v1/sync/jobs',
  job: '/v1/sync/jobs/{jobId}',
  content: '/v1/sync/jobs/{jobId}/content',
} as const

/** 复制功能的能力声明。 */
export interface SyncCapabilities {
  readonly schemaVersion: typeof SYNC_CAPABILITIES_VERSION
  readonly deviceId: string
  readonly canScan: CapabilityState
  readonly canCopy: CapabilityState
  readonly canBackup: CapabilityState
  readonly canRestore: CapabilityState
  readonly limits: typeof SYNC_LIMITS
}

/** 扫描请求：本机已登记的一个根目录。 */
export interface SyncScanRequest {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly rootId: string
}

/** 扫描到的一个条目。path 由原始名称段组成。 */
export interface SyncEntry {
  readonly entryId: string
  readonly path: readonly string[]
  readonly kind: 'file' | 'directory'
  readonly sizeBytes: number | null
  readonly modifiedAt: number | null
  readonly error: OperationError | null
}

/** 一次扫描的快照，只在当前会话有效；error 非空表示扫描失败，error 为 null 时空数组表示空目录。 */
export interface SyncSnapshot {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly scanId: string
  readonly deviceId: string
  readonly rootId: string
  readonly observedAt: number
  readonly entries: readonly SyncEntry[]
  readonly error: OperationError | null
}

/** 扫描状态；scannedEntries 是这次扫描已读到的条目数。 */
export interface SyncScanState {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly scanId: string
  readonly rootId: string
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly scannedEntries: number
  readonly snapshot: SyncSnapshot | null
  readonly error: OperationError | null
}

/** 计划里会改动目标的动作；执行顺序是新建文件夹、写文件，最后由深到浅删除。 */
export type SyncWriteAction =
  'create-directory' | 'create-file' | 'replace-file' | 'delete-file' | 'delete-directory'

/** 计划项的动作，包括不改动目标的 skip、keep 和 conflict。 */
export type SyncAction = SyncWriteAction | 'skip' | 'keep' | 'conflict'

/** 计划的一项，对应一个原始路径；两端的内容在计划的快照里。 */
export interface SyncPlanEntry {
  readonly path: readonly string[]
  readonly action: SyncAction
  readonly sourceEntryId: string | null
  readonly targetEntryId: string | null
}

/** 计划中的问题。path 为 null 表示整份扫描或任务上下文的问题，文件问题保留原始路径。 */
export interface SyncIssue {
  readonly code:
    | 'invalid-context'
    | 'scan-failed'
    | 'unreadable-entry'
    | 'unknown-content'
    | 'name-conflict'
    | 'type-conflict'
    | 'resource-limit'
  readonly side: 'source' | 'target' | 'both'
  readonly path: readonly string[] | null
}

/** 生成计划的输入。 */
export interface SyncPlanInput {
  readonly planId: string
  readonly projectId: string
  readonly operation: 'copy' | 'restore'
  readonly direction: SyncDirection | 'local-restore'
  readonly shouldBackup: boolean
  /** 只在目标有的条目：false 保留，true 删除。恢复计划固定为 true。 */
  readonly shouldDeleteExtras: boolean
  readonly source: SyncSnapshot
  readonly target: SyncSnapshot
}

/** 计划：动作、问题和统计。传输统计只算要写入的文件，备份统计算写入前的全部目标文件。 */
export interface SyncPlan extends SyncPlanInput {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly entries: readonly SyncPlanEntry[]
  readonly issues: readonly SyncIssue[]
  readonly transferFileCount: number
  readonly totalFileBytes: number | null
  readonly backupFileBytes: number | null
  readonly canExecute: boolean
}

/** 备份清单里的一个文件；fileId 是备份内的私有文件编号。 */
export interface SyncBackupFile {
  readonly fileId: string
  readonly path: readonly string[]
  readonly sizeBytes: number
  readonly modifiedAt: number | null
}

/** 备份的触发原因：传输前、恢复前或手动备份。 */
export type SyncBackupReason = 'copy' | 'restore' | 'manual'

/** 一份已提交备份的清单。 */
export interface SyncBackupManifest {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly backupId: string
  readonly projectId: string
  readonly deviceId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: SyncBackupReason
  readonly files: readonly SyncBackupFile[]
}

/** 本机手动备份的运行状态。 */
export type SyncManualBackupStatus = 'running' | 'succeeded' | 'empty' | 'failed' | 'cancelled'

/** 本机手动备份的工作阶段。 */
export type SyncManualBackupStage = 'scanning' | 'backing-up' | 'done'

/** 本机手动备份的任务状态。 */
export interface SyncManualBackupState {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly taskId: string
  readonly projectId: string
  readonly rootId: string
  readonly status: SyncManualBackupStatus
  readonly stage: SyncManualBackupStage
  readonly updatedAt: number
  readonly isCancelRequested: boolean
  /** 已复制进备份的字节数。 */
  readonly bytesCopied: number
  /** 本次要备份的总字节数；扫描完成前或目录为空时为 0。 */
  readonly totalBytes: number
  /** 成功提交后的备份 ID；未成功或目录为空时为 null。 */
  readonly backupId: string | null
  /** 成功提交后的备份文件数；未成功或目录为空时为 null。 */
  readonly fileCount: number | null
  readonly error: OperationError | null
  /** 备份已提交但轮换失败，或失败、取消后清理暂存失败时的错误。 */
  readonly cleanupError: OperationError | null
}

/** 没有提交清单的残留备份；occupiedBytes 是它占用的字节数，读不到时为 null。 */
export interface SyncIncompleteBackup {
  readonly backupId: string
  readonly occupiedBytes: number | null
}

/** 本机备份库的设置。 */
export interface SyncBackupSettings {
  readonly schemaVersion: 4
  /** 每个游戏保留的完整备份份数，BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX。 */
  readonly keepCount: number
}

/** 一项写入的实际结果；unknown 带 result-unknown 错误。 */
export interface SyncWriteOutcome {
  readonly path: readonly string[]
  readonly action: SyncWriteAction
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'not-attempted' | 'unknown'
  /** 写文件成功时是写入的字节数，其余为 null。 */
  readonly sizeBytes: number | null
  readonly error: OperationError | null
}

/** 一次写入的结果：备份、逐项结果和清理分开记录。 */
export interface SyncApplyResult {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly planId: string
  readonly backupId: string | null
  /** 实际提交的备份清单里的文件数；没有备份或不知道时为 null。 */
  readonly backupFileCount: number | null
  readonly outcomes: readonly SyncWriteOutcome[]
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}

/** 本机恢复任务的状态。 */
export type SyncRestoreStatus =
  'preparing' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** 本机恢复任务所处的阶段。 */
export type SyncRestoreStage =
  'preparing' | 'ready' | 'verifying' | 'backing-up' | 'writing' | 'cleaning' | 'done'

/** 本机恢复任务失败或中断时所在的阶段。 */
export type SyncRestoreFailureStage = 'preparing' | 'backing-up' | 'writing'

/** 本机恢复任务在备份与写入阶段的字节和文件计数。 */
export interface SyncRestoreProgress {
  readonly backupBytesCopied: number
  readonly totalBackupBytes: number
  readonly publishedFiles: number
  readonly totalFiles: number
  readonly fileBytesPublished: number
  readonly totalFileBytes: number | null
}
