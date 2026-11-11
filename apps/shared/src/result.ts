import type { ErrorDevice, OperationErrorCode, OperationResult } from './protocol/contracts.ts'
import { HTTP_ERROR_STATUS } from './protocol/protocol.ts'

/**
 * 界面显示用的错误。code 为错误码时按错误码显示本地化说明，message 作为详情；
 * code 为 null 时 message 是可以直接显示的文字。
 */
export interface ShownError {
  readonly code: OperationErrorCode | null
  readonly message: string
  /** 出错的一端；能确定时写在说明前。 */
  readonly device?: ErrorDevice
}

/** 带错误码的异常。 */
export class OperationFailure extends Error {
  readonly code: OperationErrorCode
  /** 出错的一端；能确定时才有。 */
  readonly device: ErrorDevice | undefined

  constructor(code: OperationErrorCode, message: string, device?: ErrorDevice) {
    super(message)
    this.name = 'OperationFailure'
    this.code = code
    this.device = device
  }
}

function isErrorCode(value: unknown): value is OperationErrorCode {
  return typeof value === 'string' && Object.hasOwn(HTTP_ERROR_STATUS, value)
}

/**
 * 把捕获到的异常转成界面显示用的错误。
 *
 * @returns OperationFailure、带错误码的对象和消息本身是错误码的异常保留错误码；其余异常 code 为 null，message 是原消息。
 */
export function toShownError(cause: unknown): ShownError {
  if (cause instanceof OperationFailure) {
    return cause.device === undefined
      ? { code: cause.code, message: cause.message }
      : { code: cause.code, message: cause.message, device: cause.device }
  }
  if (typeof cause === 'object' && cause !== null && 'code' in cause && isErrorCode(cause.code)) {
    const message = 'message' in cause && typeof cause.message === 'string' ? cause.message : ''
    return { code: cause.code, message: message === cause.code ? '' : message }
  }
  if (cause instanceof Error) {
    return isErrorCode(cause.message)
      ? { code: cause.message, message: '' }
      : { code: null, message: cause.message }
  }
  return { code: null, message: String(cause) }
}

/**
 * 取出成功结果的值。
 *
 * @throws OperationFailure 结果是错误时抛出，带原错误的 code、message 和 device。
 */
export function unwrap<T>(result: OperationResult<T>): T {
  if (result.status === 'error') {
    throw new OperationFailure(result.error.code, result.error.message, result.error.device)
  }
  return result.value
}
