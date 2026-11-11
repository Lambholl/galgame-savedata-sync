import type { ShownError } from '../../result.ts'

/** 把错误写成原消息加错误码的一行文字；没有错误码时只有原消息。 */
export function errorDetail(error: ShownError): string {
  if (!error.code) {
    return error.message
  }
  return error.message ? `${error.message} (${error.code})` : error.code
}
