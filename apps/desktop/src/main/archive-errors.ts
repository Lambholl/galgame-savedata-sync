import type { KnownOperationError } from '@savedata-sync/shared'
import { isOperationError } from '@savedata-sync/shared'

/** 归档失败保留内部 cause；对外仅发送脱敏错误，清理错误不能覆盖原始失败。 */
export class ArchiveError extends Error {
  readonly operationError: KnownOperationError
  cleanupError: KnownOperationError | null = null

  constructor(code: KnownOperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'ArchiveError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 取消与失败分开；调用方转换为 cancelled，不创建虚构的取消错误码。 */
export class ArchiveCancelledError extends Error {
  cleanupError: KnownOperationError | null = null

  constructor(cause?: unknown) {
    super('归档操作已取消。', { cause })
    this.name = 'ArchiveCancelledError'
  }
}

/** 在有限流各检查点中断；超时 signal 映射 timeout，其余 abort 为用户取消。 */
export function checkArchiveAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    throw new ArchiveError('timeout', '归档操作超时。', reason)
  }
  throw new ArchiveCancelledError(reason)
}

/** 原生错误不带路径跨边界；已有归档/目录错误保留稳定码及原始 cause。 */
export function toArchiveError(
  error: unknown,
  signal?: AbortSignal,
): ArchiveError | ArchiveCancelledError {
  if (error instanceof ArchiveError || error instanceof ArchiveCancelledError) {
    return error
  }
  if (signal?.aborted) {
    try {
      checkArchiveAbort(signal)
    } catch (cancelled) {
      if (cancelled instanceof ArchiveError || cancelled instanceof ArchiveCancelledError) {
        return cancelled
      }
    }
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new ArchiveError('insufficient-space', '归档暂存空间不足。', error)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ArchiveError('permission-denied', '无法访问归档暂存文件。', error)
  }
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new ArchiveError('invalid-archive', '归档损坏或未完整结束。', error)
  }
  if (error && typeof error === 'object' && 'operationError' in error) {
    const value = error.operationError
    if (isOperationError(value) && value.code !== 'result-unknown') {
      return new ArchiveError(value.code, value.message, error)
    }
  }
  return new ArchiveError('io-failure', '归档读写失败，请检查权限与存储状态。', error)
}
