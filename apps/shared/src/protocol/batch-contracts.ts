import type {
  DeviceDescriptor,
  EntryReference,
  FileMetadata,
  OperationError,
  OperationResult,
  TransferDirection,
} from './contracts.ts'
import type { PROTOCOL_VERSION } from './contracts.ts'

/** 已确定原因的错误；发布结果未知（result-unknown）不属于这一类。 */
export type KnownOperationError = Exclude<OperationError, { readonly code: 'result-unknown' }>

/** 结果待确认的错误：不能自动重做写入；残留数组为空也不能说明没有写入。 */
export type ResultUnknownError = Extract<OperationError, { readonly code: 'result-unknown' }>

/** 单批和会话的固定上限，两端相同；接收请求不能放宽。 */
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

/** HTTP 返回的设备信息，在本地设备描述外加一层；sessionId 随服务重启变化，deviceId 保持不变。 */
export interface BatchDeviceDescriptor {
  readonly device: DeviceDescriptor
  readonly sessionId: string
  readonly limits: BatchLimits
}

/** 批内的一个源文件。fileId 从 f000001 连续编号，是批内索引，不是文件名或源引用。 */
export interface SourceSelection {
  readonly fileId: string
  readonly entryId: string
}

/** 下载请求：选择同一个已登记根目录中的文件，服务异步准备；不接受路径或目录递归。 */
export interface DownloadBatchRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transferId: string
  readonly sourceRootId: string
  readonly files: readonly SourceSelection[]
}

/** 已私有暂存的一个原文文件。源长度未知时在此之前实测，原日期只供展示。 */
export interface PreparedFile {
  readonly fileId: string
  readonly sourceEntryId: string
  readonly sourceParentId: string | null
  readonly sourceName: string
  readonly sourceModifiedAt: number | null
  readonly sizeBytes: number
  readonly sha256: string
}

/** 归档描述：哈希对应本次实际压缩的字节，不要求不同压缩器输出相同归档。 */
export interface ArchiveDescriptor {
  readonly format: 'tar.gz'
  readonly compressionLevel: 1
  readonly sizeBytes: number
  readonly tarSizeBytes: number
  readonly sha256: string
}

/** 批次清单，与归档分开传递，只在当前会话内有效，不用作以后比较的基线。 */
export interface BatchManifest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transferId: string
  readonly sourceDeviceId: string
  readonly sourceRootId: string
  readonly files: readonly PreparedFile[]
  readonly totalFileBytes: number
  readonly archive: ArchiveDescriptor
}

/** 接收目标：父目录必须已存在；名称是单文件名，不能用来展开归档路径。 */
export interface TargetSelection {
  readonly fileId: string
  readonly parentId: string | null
  readonly name: string
}

/** 接收登记请求：声明本次清单和目标，此时文件还没写入；方向由端点决定。 */
export interface ReceiveBatchRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly manifest: BatchManifest
  readonly targetRootId: string
  readonly targets: readonly TargetSelection[]
}

/** 传输进度：四类字节计数分别单调递增；总量未知时为 null，空文件的原文总量可以是 0。 */
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

/** 已发布文件的结果；成功必须由目标最终回读确认，公开元数据不能代替内容验证。 */
export interface PublishedFileResult {
  readonly fileId: string
  readonly status: 'succeeded'
  readonly bytesWritten: number
  readonly sha256: string
  readonly entry: FileMetadata
}

/** 单文件结果：失败、取消和未知只列本次新建的残留；not-attempted 表示还没开始创建目标。 */
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

/** 私有缓存的清理结果，与文件发布结果分开；清理失败不改变已成功的写入。 */
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

/** 运行中的状态：阶段按报告端的职责划分，发送端没有目标校验和发布阶段。 */
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

/** 结束状态：发送端的 sent 只表示本机发送完成，只有接收端能报告全部文件发布成功。 */
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

/** 批量任务的状态快照，只读；未知、过期或新会话都不能作为重做写入的依据。 */
export type BatchState = BatchRunningState | BatchTerminalState

/** HTTP 设备信息的响应，与目录桥使用的本地设备描述分开。 */
export type DeviceResponse = OperationResult<BatchDeviceDescriptor>

/** 批量任务响应；200、201、202 只表示取得、登记或接受了状态，结果要看 value.status。 */
export type BatchResponse = OperationResult<BatchState>

/** 清单响应，准备完成后返回；压缩体不放进 JSON。 */
export type ManifestResponse = OperationResult<BatchManifest>
