import { isOperationError } from '@savedata-sync/shared'
import type { KnownOperationError } from '@savedata-sync/shared'

/** 原生发布错误仅将稳定包络交给调用者，路径和原始错误留在 cause。 */
export class PublicationError extends Error {
  readonly operationError: KnownOperationError

  constructor(code: KnownOperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'PublicationError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 内部取消检查，不伪造错误码；成功发布与取消竞争时由实际回读结果决定。 */
export class PublicationCancelledError extends Error {
  constructor() {
    super('新文件发布已取消。')
    this.name = 'PublicationCancelledError'
  }
}

/** 不支持安全硬链接时明确拒绝，不退回会覆盖目标的 rename 或复制。 */
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
    return new PublicationError('name-conflict', '目标名称已存在，未覆盖已有条目。', error)
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new PublicationError('insufficient-space', '目标卷空间不足。', error)
  }
  if (code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
    return new PublicationError(
      'unsupported-operation',
      '目标文件系统不支持安全的新文件发布。',
      error,
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new PublicationError('permission-denied', '没有目标目录的操作权限。', error)
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new PublicationError('not-found', '目标目录或条目已经不存在。', error)
  }
  return new PublicationError('io-failure', '新文件读写失败，请核实当前目标。', error)
}
