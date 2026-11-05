import type { OperationError, OperationErrorCode, OperationResult } from '@savedata-sync/shared'

/** 目录访问错误：内部保留 cause，跨 IPC 只发送脱敏后的 operationError。 */
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

/** 把文件系统错误映射为错误码稳定、不含主机路径的错误，并保留内部 cause。 */
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

/** 执行本地操作，失败时转成 OperationResult 错误；原始错误只留在进程内。 */
export async function runDirectoryOperation<TValue>(
  operation: () => Promise<TValue>,
): Promise<OperationResult<TValue>> {
  try {
    return { status: 'success', value: await operation() }
  } catch (error) {
    return { status: 'error', error: toDirectoryError(error).operationError }
  }
}
