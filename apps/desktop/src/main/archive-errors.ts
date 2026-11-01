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
    super('The archive operation was cancelled.', { cause })
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
    throw new ArchiveError('timeout', 'The archive operation timed out.', reason)
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
    return new ArchiveError('insufficient-space', 'Archive staging space is insufficient.', error)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ArchiveError('permission-denied', 'Cannot access archive staging files.', error)
  }
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new ArchiveError('invalid-archive', 'The archive is damaged or incomplete.', error)
  }
  if (error && typeof error === 'object' && 'operationError' in error) {
    const value = error.operationError
    if (isOperationError(value) && value.code !== 'result-unknown') {
      return new ArchiveError(value.code, value.message, error)
    }
  }
  return new ArchiveError(
    'io-failure',
    'Archive I/O failed. Check permissions and storage status.',
    error,
  )
}
