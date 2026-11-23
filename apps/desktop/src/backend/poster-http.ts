import { request as httpsRequest } from 'node:https'
import {
  POSTER_LIMITS,
  POSTER_TIMEOUTS_MS,
  isPosterImageUrl,
  isPosterRequestAllowed,
} from '@savedata-sync/shared'
import type { PosterHttpRequest, PosterHttpResponse, PosterImageData } from '@savedata-sync/shared'
import { HttpOperationError } from './http-errors.ts'

/** 一个 UTF-16 码元按 UTF-8 编码最多占 3 字节，用来在解码前限制 JSON 响应体的字节数。 */
const MAX_JSON_BYTES = POSTER_LIMITS.maxJsonChars * 3

const IMAGE_MIME_TYPE = /^image\/[a-z0-9.+-]+$/u

interface RawResponse {
  readonly status: number
  readonly contentType: string | null
  readonly body: Buffer
}

/** 响应体超过调用方给的字节上限。 */
class BodyTooLargeError extends Error {
  constructor() {
    super('The response body is too large.')
    this.name = 'BodyTooLargeError'
  }
}

function headerText(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 发一次 https 请求并读完响应体；不跟随重定向，3xx 原样返回。
 *
 * @throws BodyTooLargeError 响应体超过 maxBytes 时 reject。
 * @throws Error 连接超时、读取超时、连接中断或响应体经过压缩时 reject。
 */
function send(
  url: string,
  method: 'GET' | 'POST',
  headers: Readonly<Record<string, string>>,
  body: string | null,
  maxBytes: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method,
      headers,
      // socket 空闲超过这个时间时触发 timeout 事件，覆盖等待响应头和两次读到数据之间。
      timeout: POSTER_TIMEOUTS_MS.read,
    })
    const fail = (error: Error): void => {
      clearTimeout(connectTimer)
      reject(error)
      request.destroy()
    }
    const connectTimer = setTimeout(
      () => fail(new Error('The connection timed out.')),
      POSTER_TIMEOUTS_MS.connect,
    )
    request.on('socket', (socket) => {
      // 默认 Agent 会复用 keep-alive 连接，复用的连接不再触发 secureConnect。
      if (socket.connecting) {
        socket.once('secureConnect', () => clearTimeout(connectTimer))
      } else {
        clearTimeout(connectTimer)
      }
    })
    request.on('timeout', () => fail(new Error('The response timed out.')))
    request.on('error', fail)
    request.on('response', (response) => {
      clearTimeout(connectTimer)
      // 请求不带 Accept-Encoding，服务器仍然压缩时读不了。
      const encoding = headerText(response.headers['content-encoding'])
      if (encoding !== null && encoding.toLowerCase() !== 'identity') {
        fail(new Error(`The response uses an unsupported encoding: ${encoding}`))
        return
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        fail(new BodyTooLargeError())
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          fail(new BodyTooLargeError())
          return
        }
        chunks.push(chunk)
      })
      response.on('error', fail)
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: headerText(response.headers['content-type']),
          body: Buffer.concat(chunks),
        }),
      )
      response.on('close', () => {
        if (!response.complete) {
          fail(new Error('The connection closed before the response ended.'))
        }
      })
    })
    request.end(body ?? undefined)
  })
}

function networkFailure(cause: unknown): HttpOperationError {
  return new HttpOperationError('network-failure', 'The poster source is unreachable.', cause)
}

/** 封面接口和图片的 https 执行器。 */
export interface PosterHttp {
  /**
   * 执行接口请求，收到任意 HTTP 状态码都返回响应。
   *
   * @throws HttpOperationError 请求不符合 isPosterRequestAllowed 时 code 为 invalid-request；
   *   连不上、超时或响应体超过 POSTER_LIMITS.maxJsonChars 时 code 为 network-failure。
   */
  request(input: PosterHttpRequest): Promise<PosterHttpResponse>
  /**
   * 下载图片。
   *
   * @throws HttpOperationError 地址不符合 isPosterImageUrl 时 code 为 invalid-request；
   *   HTTP 404 时为 not-found；超过 POSTER_LIMITS.maxImageBytes 时为 resource-limit；
   *   连不上、超时、其他非 2xx 状态或响应不是图片时为 network-failure。
   */
  downloadImage(url: string): Promise<PosterImageData>
}

/**
 * 创建封面执行器。
 *
 * @param userAgent 每个请求都带的 User-Agent，即 createPosterUserAgent 的结果。
 */
export function createPosterHttp(userAgent: string): PosterHttp {
  return {
    async request(input) {
      if (!isPosterRequestAllowed(input)) {
        throw new HttpOperationError('invalid-request', 'The poster request is not allowed.')
      }
      let response: RawResponse
      try {
        response = await send(
          input.url,
          input.method,
          { ...input.headers, 'User-Agent': userAgent },
          input.body,
          MAX_JSON_BYTES,
        )
      } catch (error) {
        throw networkFailure(error)
      }
      const body = response.body.toString('utf8')
      if (body.length > POSTER_LIMITS.maxJsonChars) {
        throw networkFailure(new BodyTooLargeError())
      }
      return { status: response.status, contentType: response.contentType, body }
    },

    async downloadImage(url) {
      if (!isPosterImageUrl(url)) {
        throw new HttpOperationError('invalid-request', 'The image address is not allowed.')
      }
      let response: RawResponse
      try {
        response = await send(
          url,
          'GET',
          { Accept: 'image/*', 'User-Agent': userAgent },
          null,
          POSTER_LIMITS.maxImageBytes,
        )
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw new HttpOperationError('resource-limit', 'The image is too large.', error)
        }
        throw networkFailure(error)
      }
      if (response.status === 404) {
        throw new HttpOperationError('not-found', 'The image no longer exists.')
      }
      const mimeType = response.contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (
        response.status < 200 ||
        response.status > 299 ||
        !IMAGE_MIME_TYPE.test(mimeType) ||
        response.body.length === 0
      ) {
        throw networkFailure(
          new Error(`Unexpected image response: HTTP ${response.status} ${mimeType}`),
        )
      }
      return { mimeType, data: response.body.toString('base64') }
    },
  }
}
