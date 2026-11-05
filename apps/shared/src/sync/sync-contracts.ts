import type { CapabilityState, OperationError, TransferDirection } from '../protocol/contracts.ts'

/** 复制功能的 schema 版本，与批量传输的 PROTOCOL_VERSION 各自独立。 */
export const SYNC_SCHEMA_VERSION = 1
/**
 * 能力声明的版本，也是两端能否互传的唯一门槛。2 表示支持 sync.job 任务观察与
 * SyncJobState 的 failureStage，3 表示计划可带 shouldDeleteExtras 与删除动作；
 * 版本不同时发起方在扫描前就提示更新，不会走到任务阶段。
 */
export const SYNC_CAPABILITIES_VERSION = 3

/** 单次扫描的上限；文件传输和备份另受 BATCH_LIMITS 约束。 */
export const SYNC_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxDepth: 64,
  maxPathLength: 4096,
  maxNameLength: 255,
  maxRetainedScans: 32,
  snapshotLifetimeMs: 600000,
  scanTimeoutMs: 1800000,
} as const)

/** 复制功能的 HTTP 路由，先读 capabilities 协商版本和上限；/v1/device 不含复制功能的字段。 */
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

export interface SyncCapabilities {
  readonly schemaVersion: typeof SYNC_CAPABILITIES_VERSION
  readonly deviceId: string
  readonly canScan: CapabilityState
  readonly canCopy: CapabilityState
  readonly canBackup: CapabilityState
  readonly canRestore: CapabilityState
  readonly limits: typeof SYNC_LIMITS
}

/** 扫描请求：只引用本机已登记的根目录，没有路径和可放宽的上限。 */
export interface SyncScanRequest {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly rootId: string
}

/** 扫描到的一个条目。名称是原始路径段；ID 由原生层解析，路径不能直接当系统路径用。 */
export interface SyncEntry {
  readonly entryId: string
  readonly path: readonly string[]
  readonly kind: 'file' | 'directory'
  readonly sizeBytes: number | null
  readonly modifiedAt: number | null
  readonly sha256: string | null
  readonly error: OperationError | null
}

/** 一次扫描的快照，只在当前会话有效；error 非空表示扫描失败，成功的空数组才是真实空目录。 */
export interface SyncSnapshot {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly scanId: string
  readonly deviceId: string
  readonly rootId: string
  readonly observedAt: number
  readonly entries: readonly SyncEntry[]
  readonly error: OperationError | null
}

/** 扫描状态：计数只表示本次读取进度；取消和失败不显示成空目录。 */
export interface SyncScanState {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly scanId: string
  readonly rootId: string
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly scannedEntries: number
  readonly bytesRead: number
  readonly snapshot: SyncSnapshot | null
  readonly error: OperationError | null
}

/** 计划里会改动目标的动作；执行顺序是新建文件夹、写文件，最后由深到浅删除。 */
export type SyncWriteAction =
  'create-directory' | 'create-file' | 'replace-file' | 'delete-file' | 'delete-directory'

export type SyncAction = SyncWriteAction | 'skip' | 'keep' | 'conflict'

/** 计划的一项，对应同一个原始路径；完整的内容期望在计划的两端快照里。 */
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

/** 生成计划的输入：调用者提供本次 ID 和方向；shouldBackup 的缺省值由本机设置层提供。 */
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

/** 可执行计划：快照随计划留在本次内存中；传输统计待写入的文件，备份统计写入前的全部目标文件。 */
export interface SyncPlan extends SyncPlanInput {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly entries: readonly SyncPlanEntry[]
  readonly issues: readonly SyncIssue[]
  readonly transferFileCount: number
  readonly totalFileBytes: number | null
  readonly backupFileBytes: number | null
  readonly canExecute: boolean
}

/** 备份清单里的一个文件，只为手动恢复保存；fileId 对应应用私有文件，不是用户路径。 */
export interface SyncBackupFile {
  readonly fileId: string
  readonly path: readonly string[]
  readonly sizeBytes: number
  readonly sha256: string
  readonly modifiedAt: number | null
}

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

/** 没有提交清单的残留轮次；occupiedBytes 只统计应用私有文件，读不到时为 null，不算作 0。 */
export interface SyncIncompleteBackup {
  readonly backupId: string
  readonly occupiedBytes: number | null
}

/** 写入前备份策略：是否备份，以及每个游戏、每个目录保留的完整备份份数。 */
export interface SyncBackupPolicy {
  readonly shouldBackup: boolean
  /** BACKUP_KEEP_COUNT_MIN–BACKUP_KEEP_COUNT_MAX。 */
  readonly keepCount: number
}

/** 某个游戏目录的单独设置；没有记录的游戏目录跟随全局设置。 */
export interface SyncBackupPreference extends SyncBackupPolicy {
  readonly projectId: string
  readonly rootId: string
}

/** 备份设置，与游戏配置分开保存在本机备份目录；v1 只有逐目录开关，读取时升级。 */
export interface SyncBackupSettings {
  readonly schemaVersion: 2
  /** 全局设置。 */
  readonly defaults: SyncBackupPolicy
  readonly projects: readonly SyncBackupPreference[]
}

/** 一项写入的实际结果；unknown 必须带 result-unknown，不能自动重做写入。 */
export interface SyncWriteOutcome {
  readonly path: readonly string[]
  readonly action: SyncWriteAction
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'not-attempted' | 'unknown'
  readonly sizeBytes: number | null
  readonly sha256: string | null
  readonly error: OperationError | null
}

/** 写入结果：备份和发布结果与清理分开；清理错误不改变已确认成功的文件。 */
export interface SyncApplyResult {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly planId: string
  readonly backupId: string | null
  /** 实际提交的备份清单里的文件数；不是计划里的覆盖数。没有备份或不知道时为 null。 */
  readonly backupFileCount: number | null
  readonly outcomes: readonly SyncWriteOutcome[]
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}
