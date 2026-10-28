import type { CapabilityState, OperationError, TransferDirection } from '../protocol/contracts.ts'

/** 新复制能力独立版本，不改变旧批量 v1 的非覆盖语义。 */
export const SYNC_SCHEMA_VERSION = 1

/** 只限制本次扫描；文件传输与备份另受 BATCH_LIMITS 约束。 */
export const SYNC_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxDepth: 64,
  maxPathLength: 4096,
  maxNameLength: 255,
  maxRetainedScans: 32,
  backupRetention: 3,
  snapshotLifetimeMs: 600000,
  scanTimeoutMs: 1800000,
} as const)

/** 新能力按独立入口协商，不能改变旧 /v1/device 的封闭字段。 */
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
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly deviceId: string
  readonly canScan: CapabilityState
  readonly canCopy: CapabilityState
  readonly canBackup: CapabilityState
  readonly canRestore: CapabilityState
  readonly limits: typeof SYNC_LIMITS
}

/** 扫描只引用本机已登记根，不接受路径或可放宽预算。 */
export interface SyncScanRequest {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly rootId: string
}

/** 名称使用原始路径段；ID 由原生层解析，路径不能直接充当系统路径。 */
export interface SyncEntry {
  readonly entryId: string
  readonly path: readonly string[]
  readonly kind: 'file' | 'directory'
  readonly sizeBytes: number | null
  readonly modifiedAt: number | null
  readonly sha256: string | null
  readonly error: OperationError | null
}

/** 仅本次会话的快照；error 非空表示扫描失败，空成功数组才是真实空目录。 */
export interface SyncSnapshot {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly scanId: string
  readonly deviceId: string
  readonly rootId: string
  readonly observedAt: number
  readonly entries: readonly SyncEntry[]
  readonly error: OperationError | null
}

/** 扫描计数只表示本次读取进度；取消与失败不伪装成空目录成功。 */
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

export type SyncAction =
  'create-directory' | 'create-file' | 'replace-file' | 'skip' | 'keep' | 'conflict'

/** 一项只对应同一原始路径；完整内容期望保留在当前计划的两端快照中。 */
export interface SyncPlanEntry {
  readonly path: readonly string[]
  readonly action: SyncAction
  readonly sourceEntryId: string | null
  readonly targetEntryId: string | null
}

/** path=null 表示整份扫描或任务上下文问题，具体文件问题保留原始路径。 */
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

/** 调用者显式提供本次 ID 和方向；shouldBackup 缺省值由本机设置层提供。 */
export interface SyncPlanInput {
  readonly planId: string
  readonly projectId: string
  readonly operation: 'copy' | 'restore'
  readonly direction: TransferDirection | 'local-restore'
  readonly shouldBackup: boolean
  readonly source: SyncSnapshot
  readonly target: SyncSnapshot
}

/** 快照随计划仅存本次内存；计数只统计本次写入/备份，不是目录大小。 */
export interface SyncPlan extends SyncPlanInput {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly entries: readonly SyncPlanEntry[]
  readonly issues: readonly SyncIssue[]
  readonly transferFileCount: number
  readonly totalFileBytes: number | null
  readonly backupFileBytes: number | null
  readonly canExecute: boolean
}

/** 持久备份清单只为手工恢复；fileId 对应应用私有文件，不是用户路径。 */
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

/** 与旧游戏配置分开保存，缺少项目设置时由读取方使用 true。 */
export interface SyncBackupPreference {
  readonly projectId: string
  readonly rootId: string
  readonly shouldBackup: boolean
}

export interface SyncBackupSettings {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly projects: readonly SyncBackupPreference[]
}

/** 只列实际观察；unknown 必须保留 result-unknown，不能自动重放写入。 */
export interface SyncWriteOutcome {
  readonly path: readonly string[]
  readonly action: 'create-directory' | 'create-file' | 'replace-file'
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'not-attempted' | 'unknown'
  readonly sizeBytes: number | null
  readonly sha256: string | null
  readonly error: OperationError | null
}

/** 备份/发布结果与清理独立；清理错误不推翻已确认成功的文件。 */
export interface SyncApplyResult {
  readonly schemaVersion: typeof SYNC_SCHEMA_VERSION
  readonly planId: string
  readonly backupId: string | null
  readonly outcomes: readonly SyncWriteOutcome[]
  readonly error: OperationError | null
  readonly cleanupError: OperationError | null
}
