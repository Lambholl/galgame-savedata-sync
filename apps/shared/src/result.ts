import type { OperationResult } from './protocol/contracts.ts'

/** 返回成功结果；失败时用原错误消息抛出 Error，由调用端显示。 */
export function unwrap<T>(result: OperationResult<T>): T {
  if (result.status === 'error') {
    throw new Error(result.error.message)
  }
  return result.value
}
