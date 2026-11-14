import type { CapabilityState, OperationError, TransferDirection } from '../protocol/contracts.ts'

/** 复制功能的 schema 版本，与 PROTOCOL_VERSION 分别计数。 */
export const SYNC_SCHEMA_VERSION = 1
/**
 * 能力声明的版本，两端相同才能互传。
 */
export const SYNC_CAPABILITIES_VERSION = 5

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
  manifest: '/v1/sync/jobs/{jobId}/manifest',
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
  readonly direction: TransferDirection | 'local-restore'
  readonly shouldBackup: boolean
  /** 只在目标有的条目：false 保留，true 删除。恢复计划固定为 false。 */
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

/** 一份已提交的写入前备份的清单。 */
export interface SyncBackupManifest {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly backupId: string
  readonly projectId: string
  readonly deviceId: string
  readonly rootId: string
  readonly createdAt: number
  readonly reason: 'copy' | 'restore'
  readonly files: readonly SyncBackupFile[]
}

/** 没有提交清单的残留备份；occupiedBytes 是它占用的字节数，读不到时为 null。 */
export interface SyncIncompleteBackup {
  readonly backupId: string
  readonly occupiedBytes: number | null
}

/** 写入前备份策略：是否备份，以及每个游戏保留的完整备份份数。 */
export interface SyncBackupPolicy {
  readonly shouldBackup: boolean
  /** BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX。 */
  readonly keepCount: number
}

/** 某个游戏的单独设置。 */
export interface SyncBackupPreference extends SyncBackupPolicy {
  readonly projectId: string
}

/** 备份设置：全局策略和逐个游戏的单独策略。 */
export interface SyncBackupSettings {
  readonly schemaVersion: 3
  /** 全局设置。 */
  readonly defaults: SyncBackupPolicy
  readonly projects: readonly SyncBackupPreference[]
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
