import type {
  DeviceDescriptor,
  EntryReference,
  FileMetadata,
  OperationError,
  OperationResult,
  TransferDirection,
} from './contracts.ts'
import type { PROTOCOL_VERSION } from './contracts.ts'

/** 除 result-unknown 以外、已确定原因的错误。 */
export type KnownOperationError = Exclude<OperationError, { readonly code: 'result-unknown' }>

/** 结果待确认的错误：写入可能已经部分或全部发生，残留数组为空时也一样。 */
export type ResultUnknownError = Extract<OperationError, { readonly code: 'result-unknown' }>

/** 单批和会话的固定上限，两端相同。 */
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

/** HTTP 返回的设备信息：设备描述、会话 ID 和固定上限。sessionId 随服务重启变化，deviceId 保持不变。 */
export interface BatchDeviceDescriptor {
  readonly device: DeviceDescriptor
  readonly sessionId: string
  readonly limits: BatchLimits
}

/** 批内的一个源文件。fileId 是从 f000001 开始连续编号的批内索引。 */
export interface SourceSelection {
  readonly fileId: string
  readonly entryId: string
}

/** 下载请求：同一个已登记根目录中的若干文件。 */
export interface DownloadBatchRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transferId: string
  readonly sourceRootId: string
  readonly files: readonly SourceSelection[]
}

/** 已暂存的一个原文文件，长度和哈希都是实测值；原日期只供展示。 */
export interface PreparedFile {
  readonly fileId: string
  readonly sourceEntryId: string
  readonly sourceParentId: string | null
  readonly sourceName: string
  readonly sourceModifiedAt: number | null
  readonly sizeBytes: number
  readonly sha256: string
}

/** 归档描述：哈希对应这次实际压缩出的字节。 */
export interface ArchiveDescriptor {
  readonly format: 'tar.gz'
  readonly compressionLevel: 1
  readonly sizeBytes: number
  readonly tarSizeBytes: number
  readonly sha256: string
}

/** 批次清单，只在当前会话内有效。 */
export interface BatchManifest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly transferId: string
  readonly sourceDeviceId: string
  readonly sourceRootId: string
  readonly files: readonly PreparedFile[]
  readonly totalFileBytes: number
  readonly archive: ArchiveDescriptor
}

/** 接收目标：已存在的父目录和单文件名。 */
export interface TargetSelection {
  readonly fileId: string
  readonly parentId: string | null
  readonly name: string
}

/** 接收登记请求：本次的清单和目标。 */
export interface ReceiveBatchRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly manifest: BatchManifest
  readonly targetRootId: string
  readonly targets: readonly TargetSelection[]
}

/** 传输进度：四类字节计数分别单调递增；总量未知时为 null，全是空文件时原文总量为 0。 */
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

/** 已发布文件的结果，内容经过目标端最终回读确认。 */
export interface PublishedFileResult {
  readonly fileId: string
  readonly status: 'succeeded'
  readonly bytesWritten: number
  readonly sha256: string
  readonly entry: FileMetadata
}

/** 单文件结果：失败、取消和未知列出本次新建的残留；not-attempted 表示还没开始创建目标。 */
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

/** 私有缓存的清理结果，与文件发布结果相互独立。 */
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

/** 运行中的状态：阶段按报告端的职责划分，目标校验和发布阶段只出现在接收端。 */
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

/** 结束状态：发送端的 sent 表示本机发送完成，文件全部发布成功由接收端报告。 */
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

/** 批量任务的状态快照。 */
export type BatchState = BatchRunningState | BatchTerminalState

/** HTTP 设备信息的响应。 */
export type DeviceResponse = OperationResult<BatchDeviceDescriptor>

/** 批量任务响应；200、201、202 分别表示取得、登记和接受了状态，任务结果看 value.status。 */
export type BatchResponse = OperationResult<BatchState>

/** 准备完成后的清单响应。 */
export type ManifestResponse = OperationResult<BatchManifest>
