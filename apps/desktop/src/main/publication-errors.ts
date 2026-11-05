import { isOperationError } from '@savedata-sync/shared'
import type { KnownOperationError } from '@savedata-sync/shared'

/** 发布错误：只把稳定的错误结果交给调用者，路径和原始错误留在 cause。 */
export class PublicationError extends Error {
  readonly operationError: KnownOperationError

  constructor(code: KnownOperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'PublicationError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 内部取消信号；成功发布与取消竞争时，以实际回读结果为准。 */
export class PublicationCancelledError extends Error {
  constructor() {
    super('New file publication was cancelled.')
    this.name = 'PublicationCancelledError'
  }
}

/** 转换发布错误；文件系统不支持硬链接时明确拒绝，因为 rename 和复制都可能覆盖目标。 */
export function toPublicationError(error: unknown): PublicationError {
  if (error instanceof PublicationError) {
    return error
  }
  if (
    error &&
    typeof error === 'object' &&
    'operationError' in error &&
    isOperationError(error.operationError) &&
    error.operationError.code !== 'result-unknown'
  ) {
    return new PublicationError(error.operationError.code, error.operationError.message, error)
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  if (code === 'EEXIST') {
    return new PublicationError(
      'name-conflict',
      'The target name already exists. The existing entry was not overwritten.',
      error,
    )
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new PublicationError(
      'insufficient-space',
      'The target volume has insufficient space.',
      error,
    )
  }
  if (code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
    return new PublicationError(
      'unsupported-operation',
      'The target file system does not support safe new file publication.',
      error,
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new PublicationError(
      'permission-denied',
      'Permission to operate on the target directory is missing.',
      error,
    )
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new PublicationError(
      'not-found',
      'The target directory or entry no longer exists.',
      error,
    )
  }
  return new PublicationError(
    'io-failure',
    'New file I/O failed. Verify the current target.',
    error,
  )
}
