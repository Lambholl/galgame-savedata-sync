import type { OperationError, OperationErrorCode, OperationResult } from '@savedata-sync/shared'

/** 内部错误保留 cause；跨 IPC 只发送脱敏后的 operationError。 */
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

/** 将文件系统错误映射为稳定且不包含主机路径的错误，不丢弃内部 cause。 */
export function toDirectoryError(error: unknown): DirectoryAccessError {
  if (error instanceof DirectoryAccessError) {
    return error
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new DirectoryAccessError('not-found', '目录或文件已不存在，请刷新目录。', error)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DirectoryAccessError('permission-denied', '无法读取所选目录或文件。', error)
  }
  return new DirectoryAccessError('io-failure', '目录操作失败，请检查权限与存储状态。', error)
}

/** 本地操作失败转为共享包络；原始错误只保留在进程内，不暴露路径或堆栈。 */
export async function runDirectoryOperation<TValue>(
  operation: () => Promise<TValue>,
): Promise<OperationResult<TValue>> {
  try {
    return { status: 'success', value: await operation() }
  } catch (error) {
    return { status: 'error', error: toDirectoryError(error).operationError }
  }
}
