import type { OperationError, OperationErrorCode, OperationResult } from '@savedata-sync/shared'

/** 目录访问错误：operationError 是脱敏后的错误，原始错误在 cause。 */
export class DirectoryAccessError extends Error {
  readonly operationError: OperationError

  constructor(
    code: Exclude<OperationErrorCode, 'result-unknown'>,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'DirectoryAccessError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 把文件系统错误转成错误码稳定、消息不含路径的 DirectoryAccessError，原始错误放在 cause。 */
export function toDirectoryError(error: unknown): DirectoryAccessError {
  if (error instanceof DirectoryAccessError) {
    return error
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new DirectoryAccessError(
      'not-found',
      'The directory or file no longer exists. Refresh the directory.',
      error,
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DirectoryAccessError(
      'permission-denied',
      'Cannot read the selected directory or file.',
      error,
    )
  }
  return new DirectoryAccessError(
    'io-failure',
    'The directory operation failed. Check permissions and storage status.',
    error,
  )
}

/** 执行本地操作，失败时返回脱敏后的错误结果。 */
export async function runDirectoryOperation<TValue>(
  operation: () => Promise<TValue>,
): Promise<OperationResult<TValue>> {
  try {
    return { status: 'success', value: await operation() }
  } catch (error) {
    return { status: 'error', error: toDirectoryError(error).operationError }
  }
}
