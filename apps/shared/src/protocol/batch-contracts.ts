import type {
  DeviceDescriptor,
  EntryReference,
  FileMetadata,
  OperationError,
  OperationResult,
  TransferDirection,
} from './contracts.ts'
import type { PROTOCOL_VERSION } from './contracts.ts'

/** 已确定的失败原因；未知发布结果不能放入普通失败分支。 */
export type KnownOperationError = Exclude<OperationError, { readonly code: 'result-unknown' }>

/** 结果待确认不允许自动重放；空残留数组也不能证明没有写入。 */
export type ResultUnknownError = Extract<OperationError, { readonly code: 'result-unknown' }>

/** 双端固定相同的单批/会话预算；接收请求不能放宽这些限制。 */
export interface BatchLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalFileBytes: number
  readonly maxTarBytes: number
  readonly maxArchiveBytes: number
  readonly maxJsonBytes: number
  readonly maxConcurrentBatches: number
  readonly maxTransfersPerSession: number
}

/** HTTP 设备响应包装本地 DTO；sessionId 随服务重启变化，deviceId 保持稳定。 */
export interface BatchDeviceDescriptor {
  readonly device: DeviceDescriptor
  readonly sessionId: string
  readonly limits: BatchLimits
}

/** fileId 为从 f000001 连续编号的批内索引，不是文件名或源引用。 */
export interface SourceSelection {
  readonly fileId: string
  readonly entryId: string
}

/** 仅选择同一已登记根中的文件；服务异步准备，不接受路径或目录递归请求。 */
export interface DownloadBatchRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transferId: string
  readonly sourceRootId: string
  readonly files: readonly SourceSelection[]
}

/** 已私有暂存的本次原文；未知源长度在此之前实测，原日期只供展示。 */
export interface PreparedFile {
  readonly fileId: string
  readonly sourceEntryId: string
  readonly sourceParentId: string | null
  readonly sourceName: string
  readonly sourceModifiedAt: number | null
  readonly sizeBytes: number
  readonly sha256: string
}

/** 哈希对应本次实际压缩字节，不要求不同压缩器输出相同归档。 */
export interface ArchiveDescriptor {
  readonly format: 'tar.gz'
  readonly compressionLevel: 1
  readonly sizeBytes: number
  readonly tarSizeBytes: number
  readonly sha256: string
}

/** 清单与归档分开传递，只在当前会话存活，不构成历史同步基线。 */
export interface BatchManifest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transferId: string
  readonly sourceDeviceId: string
  readonly sourceRootId: string
  readonly files: readonly PreparedFile[]
  readonly totalFileBytes: number
  readonly archive: ArchiveDescriptor
}

/** 目标父目录必须已经存在；名称为单文件名，不能用于展开归档路径。 */
export interface TargetSelection {
  readonly fileId: string
  readonly parentId: string | null
  readonly name: string
}

/** 注册接收仅声明本次清单/目标，不代表文件已写入；方向由端点固定。 */
export interface ReceiveBatchRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly manifest: BatchManifest
  readonly targetRootId: string
  readonly targets: readonly TargetSelection[]
}

/** 四类字节计数分别单调递增；总量未知用 null，空文件总原文量可为 0。 */
export interface BatchProgress {
  readonly sourceBytesRead: number
  readonly archiveBytesTransferred: number
  readonly fileBytesVerified: number
  readonly fileBytesPublished: number
  readonly totalFileBytes: number | null
  readonly totalArchiveBytes: number | null
  readonly totalFiles: number
  readonly verifiedFiles: number
  readonly publishedFiles: number
}

/** 成功必须由目标最终回读确认；公开元数据不能替代真实内容验证。 */
export interface PublishedFileResult {
  readonly fileId: string
  readonly status: 'succeeded'
  readonly bytesWritten: number
  readonly sha256: string
  readonly entry: FileMetadata
}

/** 文件失败/取消/未知只列本次新建的残留；not-attempted 明确未开始目标创建。 */
export type FileOutcome =
  | PublishedFileResult
  | {
      readonly fileId: string
      readonly status: 'failed'
      readonly error: KnownOperationError
      readonly residualEntries: readonly EntryReference[]
    }
  | {
      readonly fileId: string
      readonly status: 'cancelled'
      readonly residualEntries: readonly EntryReference[]
    }
  | {
      readonly fileId: string
      readonly status: 'unknown'
      readonly error: ResultUnknownError
      readonly residualEntries: readonly EntryReference[]
    }
  | {
      readonly fileId: string
      readonly status: 'not-attempted'
      readonly reason: 'batch-invalid' | 'prior-failure' | 'cancelled'
    }

/** 私有清理问题独立于文件发布结果；不因清理失败把成功写入改成未写入。 */
export type BatchCleanup =
  | { readonly cleanupStatus: 'not-needed' | 'complete'; readonly cleanupError: null }
  | {
      readonly cleanupStatus: 'incomplete'
      readonly cleanupError: KnownOperationError & { readonly code: 'cleanup-failed' }
    }
  | { readonly cleanupStatus: 'unknown'; readonly cleanupError: ResultUnknownError }

interface BatchIdentity {
  readonly transferId: string
  readonly direction: TransferDirection
  readonly updatedAt: number
}

/** 阶段按报告端职责封闭；sender 不执行目标校验/发布。 */
export type BatchRunningState = BatchIdentity & {
  readonly status: 'running'
  readonly progress: BatchProgress
  readonly cancelRequested: boolean
} & (
    | {
        readonly role: 'sender'
        readonly stage: 'preparing' | 'ready' | 'transferring' | 'cleaning'
        readonly fileResults: null
      }
    | {
        readonly role: 'receiver'
        readonly stage:
          | 'preparing'
          | 'awaiting-content'
          | 'transferring'
          | 'verifying'
          | 'publishing'
          | 'cleaning'
        readonly fileResults: readonly FileOutcome[]
      }
  )

type BatchEndReason =
  | { readonly status: 'failed'; readonly error: KnownOperationError }
  | { readonly status: 'cancelled'; readonly error: null }
  | { readonly status: 'unknown'; readonly error: ResultUnknownError }

/** sender sent 只代表本机发送完成；receiver 才能报告全部文件发布成功。 */
export type BatchTerminalState = BatchIdentity &
  BatchCleanup &
  (
    | ({ readonly role: 'sender'; readonly fileResults: null } & (
        BatchEndReason | { readonly status: 'sent'; readonly error: null }
      ))
    | ({ readonly role: 'receiver'; readonly fileResults: readonly FileOutcome[] } & (
        BatchEndReason | { readonly status: 'succeeded'; readonly error: null }
      ))
  )

/** 查询返回只读快照；未知/过期/新会话均不授权重放写入。 */
export type BatchState = BatchRunningState | BatchTerminalState

/** HTTP 设备信息与本地设备 DTO 分开，目录桥无需迁移。 */
export type DeviceResponse = OperationResult<BatchDeviceDescriptor>

/** 200/201/202 包络仅表示取得/登记/接纳状态，须检查 value.status。 */
export type BatchResponse = OperationResult<BatchState>

/** 准备完成后返回独立清单；不把压缩体放入 JSON。 */
export type ManifestResponse = OperationResult<BatchManifest>
