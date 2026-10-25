import type {
  DirectoryMetadata,
  DirectoryListing,
  FileMetadata,
  OperationResult,
  TransferProgress,
  TransferReceipt,
  TransferState,
  OperationError,
} from '../src/index.ts'

declare const directory: DirectoryMetadata
declare const file: FileMetadata
declare const progress: TransferProgress
declare const receipt: TransferReceipt
declare const listing: DirectoryListing

// @ts-expect-error 目录没有可汇总的大小，不能赋值字节数。
const sizedDirectory: DirectoryMetadata = { ...directory, sizeBytes: 1 }

// @ts-expect-error 快照只读，消费方不能修改平台采集的元数据。
file.sizeBytes = 1

// @ts-expect-error 清单数组只读，不允许跨模块追加条目。
listing.entries[0] = file

// @ts-expect-error 进度不能作为已发布的成功回执。
const prematureReceipt: TransferReceipt = progress

// @ts-expect-error 成功回执的目标必须是文件，不能是目录。
const directoryReceipt: TransferReceipt = { ...receipt, entry: directory }

const readResult: OperationResult<DirectoryListing> = { status: 'success', value: listing }
if (readResult.status === 'success') {
  // @ts-expect-error 成功读取不携带失败错误。
  void readResult.error
}

function inspectState(state: TransferState): void {
  if (state.status === 'running') {
    const stage = state.stage
    // @ts-expect-error 字节传满不代表已经存在最终条目。
    void state.entry
    void stage
  }
  if (state.status === 'unknown') {
    const code: 'result-unknown' = state.error.code
    // @ts-expect-error 待确认状态不是成功状态，没有成功回执的哈希。
    void state.sha256
    void code
  }
}

// @ts-expect-error 结果未知不得承诺直接重试。
const unsafeRetry: OperationError = { code: 'result-unknown', message: '待确认', canRetry: true }

void [sizedDirectory, prematureReceipt, directoryReceipt, inspectState, unsafeRetry]
