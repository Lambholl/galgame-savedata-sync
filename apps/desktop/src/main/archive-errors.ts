import type { KnownOperationError } from '@savedata-sync/shared'
import { isOperationError } from '@savedata-sync/shared'

/** 归档失败的错误：operationError 是脱敏后的错误，原始错误在 cause；清理失败另存在 cleanupError。 */
export class ArchiveError extends Error {
  readonly operationError: KnownOperationError
  cleanupError: KnownOperationError | null = null

  constructor(code: KnownOperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'ArchiveError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 表示归档操作被取消；清理失败存在 cleanupError。 */
export class ArchiveCancelledError extends Error {
  cleanupError: KnownOperationError | null = null

  constructor(cause?: unknown) {
    super('The archive operation was cancelled.', { cause })
    this.name = 'ArchiveCancelledError'
  }
}

/**
 * signal 已中断时抛错。
 *
 * @throws ArchiveError 中断原因是 TimeoutError 时抛出，错误码为 timeout。
 * @throws ArchiveCancelledError 其他原因中断时抛出。
 */
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

/** 把平台错误转成 ArchiveError，消息里不带路径；已有的归档和目录错误保留错误码和原始 cause。 */
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
