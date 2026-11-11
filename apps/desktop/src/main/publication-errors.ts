import { isOperationError } from '@savedata-sync/shared'
import type { KnownOperationError } from '@savedata-sync/shared'

/** 发布错误：operationError 是脱敏后的错误，原始错误在 cause。 */
export class PublicationError extends Error {
  readonly operationError: KnownOperationError

  constructor(code: KnownOperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'PublicationError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 表示发布被取消。 */
export class PublicationCancelledError extends Error {
  constructor() {
    super('New file publication was cancelled.')
    this.name = 'PublicationCancelledError'
  }
}

// 文件系统不支持硬链接时直接报错，不退回 rename 或复制：这两种方式都可能覆盖目标。
/** 把任意错误转成 PublicationError；文件系统不支持硬链接时错误码为 unsupported-operation。 */
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
