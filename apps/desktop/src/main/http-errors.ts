import { isOperationError } from '@savedata-sync/shared'
import type { OperationError } from '@savedata-sync/shared'

/** HTTP 内部保留 cause，对外只返回稳定且脱敏的 operationError。 */
export class HttpOperationError extends Error {
  readonly operationError: OperationError

  constructor(code: OperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'HttpOperationError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 仅信任适配层明确的错误包络，不发送 Node 原始消息、堆栈或路径。 */
export function toHttpError(error: unknown): HttpOperationError {
  if (error instanceof HttpOperationError) return error
  if (error && typeof error === 'object' && 'operationError' in error) {
    const value = error.operationError
    if (isOperationError(value)) return new HttpOperationError(value.code, value.message, error)
  }
  return new HttpOperationError('io-failure', '本地服务操作失败。', error)
}
