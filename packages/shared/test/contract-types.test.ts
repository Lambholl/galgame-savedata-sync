import type {
  BatchManifest,
  BatchRunningState,
  BatchState,
  BatchTerminalState,
  DirectoryMetadata,
  DirectoryListing,
  FileMetadata,
  OperationResult,
  OperationError,
  PublishedFileResult,
  ReceiveBatchRequest,
} from '../src/index.ts'

declare const directory: DirectoryMetadata
declare const file: FileMetadata
declare const progress: BatchRunningState
declare const receipt: PublishedFileResult
declare const listing: DirectoryListing
declare const manifest: BatchManifest
declare const request: ReceiveBatchRequest

// @ts-expect-error 目录没有可汇总的大小，不能赋值字节数。
const sizedDirectory: DirectoryMetadata = { ...directory, sizeBytes: 1 }
// @ts-expect-error 快照只读，消费方不能修改平台采集的元数据。
file.sizeBytes = 1
// @ts-expect-error 清单数组只读，不允许跨模块追加条目。
listing.entries[0] = file
// @ts-expect-error 进度不能作为已发布的成功回执。
const prematureReceipt: PublishedFileResult = progress
// @ts-expect-error 成功回执的目标必须是文件，不能是目录。
const directoryReceipt: PublishedFileResult = { ...receipt, entry: directory }
// @ts-expect-error 本次归档清单不可被消费方改变成员数量。
manifest.files.length = 0
// @ts-expect-error 压缩级别固定为 1，不接受自动选择或其他格式。
const wrongArchive: BatchManifest['archive']['compressionLevel'] = 9
// @ts-expect-error 目标映射只读，不允许跨线程修改。
request.targets[0] = { fileId: 'f000001', parentId: null, name: '其他.sav' }

const readResult: OperationResult<DirectoryListing> = { status: 'success', value: listing }
if (readResult.status === 'success') {
  // @ts-expect-error 成功读取不携带失败错误。
  void readResult.error
}

function inspectState(state: BatchState): void {
  if (state.status === 'running') {
    const stage = state.stage
    // @ts-expect-error 运行进度不带终态错误。
    void state.error
    void stage
  } else if (state.status === 'unknown') {
    const code: 'result-unknown' = state.error.code
    // @ts-expect-error 终态不再携带阶段进度。
    void state.progress
    void code
  }
  if (state.status === 'succeeded') {
    const receiver: 'receiver' = state.role
    void receiver
  }
  if (state.role === 'sender') {
    const noResults: null = state.fileResults
    // @ts-expect-error sender 不能发出目标已发布成功的终态。
    const success: 'succeeded' = state.status
    void [noResults, success]
  }
}

// @ts-expect-error 结果未知不得承诺直接重试。
const unsafeRetry: OperationError = { code: 'result-unknown', message: '待确认', canRetry: true }
// @ts-expect-error 旧会话不能直接重放原写入。
const unsafeSession: OperationError = {
  code: 'session-mismatch',
  message: '会话已变化',
  canRetry: true,
}

declare const senderEnd: Extract<BatchTerminalState, { readonly role: 'sender' }>
// @ts-expect-error sender sent 不可改成 receiver succeeded。
const falseSuccess: BatchState = { ...senderEnd, status: 'succeeded' }
// @ts-expect-error 清理失败必须有 cleanup-failed 错误，不能带 null。
const hiddenCleanup: BatchState = { ...senderEnd, cleanupStatus: 'incomplete', cleanupError: null }

void [
  sizedDirectory,
  prematureReceipt,
  directoryReceipt,
  wrongArchive,
  inspectState,
  unsafeRetry,
  unsafeSession,
  falseSuccess,
  hiddenCleanup,
]
