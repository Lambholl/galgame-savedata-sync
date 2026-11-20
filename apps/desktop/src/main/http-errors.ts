import { isOperationError } from '@savedata-sync/shared'
import type { OperationError } from '@savedata-sync/shared'

/** HTTP 服务的错误：operationError 是脱敏后的错误，原始错误在 cause。 */
export class HttpOperationError extends Error {
  readonly operationError: OperationError

  /** @param device 出错的目录在哪一端；不传时 operationError 不带 device。 */
  constructor(
    code: OperationError['code'],
    message: string,
    cause?: unknown,
    device?: OperationError['device'],
  ) {
    super(message, { cause })
    this.name = 'HttpOperationError'
    this.operationError =
      device === undefined
        ? { code, message, canRetry: false }
        : { code, message, canRetry: false, device }
  }
}

/** 把任意错误转成 HttpOperationError；已知的适配层错误保留错误码，其余错误换成通用的脱敏错误。 */
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
