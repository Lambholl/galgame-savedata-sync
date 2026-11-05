import { isOperationError } from '@savedata-sync/shared'
import type { OperationError } from '@savedata-sync/shared'

/** HTTP 服务内部的错误：保留 cause，对外只返回稳定且脱敏的 operationError。 */
export class HttpOperationError extends Error {
  readonly operationError: OperationError

  constructor(code: OperationError['code'], message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'HttpOperationError'
    this.operationError = { code, message, canRetry: false }
  }
}

/** 把任意错误转成 HttpOperationError；只信任适配层明确给出的错误结果，Node 原始消息、堆栈和路径不发给对方。 */
export function toHttpError(error: unknown): HttpOperationError {
  if (error instanceof HttpOperationError) {
    return error
  }
  if (error && typeof error === 'object' && 'operationError' in error) {
    const value = error.operationError
    if (isOperationError(value)) {
      return new HttpOperationError(value.code, value.message, error)
    }
  }
  return new HttpOperationError('io-failure', 'The local service operation failed.', error)
}
