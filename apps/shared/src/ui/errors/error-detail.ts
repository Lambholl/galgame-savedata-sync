import type { ShownError } from '../../result.ts'

/** 错误的原始消息与错误码，写进技术详情；没有错误码时就是原始消息。 */
export function errorDetail(error: ShownError): string {
  if (!error.code) {
    return error.message
  }
  return error.message ? `${error.message} (${error.code})` : error.code
}
