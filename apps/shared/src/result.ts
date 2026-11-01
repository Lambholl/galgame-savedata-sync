import type { OperationErrorCode, OperationResult } from './protocol/contracts.ts'
import { HTTP_ERROR_STATUS } from './protocol/protocol.ts'

/**
 * 界面显示用的错误。code 为错误码时，界面显示该错误码的本地化说明，message 折叠为详情；
 * code 为 null 时 message 已是可直接显示的文字（界面自己的文案，或没有错误码的意外异常）。
 */
export interface ShownError {
  readonly code: OperationErrorCode | null
  readonly message: string
}

/** 带错误码的异常；unwrap 与平台适配层抛出它，界面据此显示本地化说明。 */
export class OperationFailure extends Error {
  readonly code: OperationErrorCode

  constructor(code: OperationErrorCode, message: string) {
    super(message)
    this.name = 'OperationFailure'
    this.code = code
  }
}

function isErrorCode(value: unknown): value is OperationErrorCode {
  return typeof value === 'string' && Object.hasOwn(HTTP_ERROR_STATUS, value)
}

/**
 * 把捕获到的异常转成界面显示用的错误：OperationFailure 与带错误码的对象保留错误码；
 * 原生插件以错误码作为拒绝消息时也按错误码显示；其余异常原样显示消息。
 */
export function toShownError(cause: unknown): ShownError {
  if (cause instanceof OperationFailure) {
    return { code: cause.code, message: cause.message }
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

/** 返回成功结果；失败时抛出带错误码的 OperationFailure，由调用端显示。 */
export function unwrap<T>(result: OperationResult<T>): T {
  if (result.status === 'error') {
    throw new OperationFailure(result.error.code, result.error.message)
  }
  return result.value
}
