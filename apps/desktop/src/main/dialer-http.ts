import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import type { Writable } from 'node:stream'
import {
  BATCH_ARCHIVE,
  BATCH_LIMITS,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  SYNC_DEVICE_HEADER,
  isOperationError,
} from '@savedata-sync/shared'
import { HttpOperationError } from './http-errors.ts'
import { inspectJsonKeys } from './http-wire.ts'

/** JSON 请求等应答的默认期限。 */
const JSON_TIMEOUT_MS = 8000

/** 一次请求的公共选项。 */
export interface DialerRequestOptions {
  /** 监听方的会话 ID，放进 x-sync-session-id；不传时不带这个头。 */
  readonly sessionId?: string
  /** 本机设备 ID，放进 x-sync-device-id；不传时不带这个头。 */
  readonly deviceId?: string
  readonly signal?: AbortSignal
}

/** 一次 JSON 请求的选项。 */
export interface DialerJsonOptions extends DialerRequestOptions {
  /** 为 true 时带 x-sync-connect: 1，表示新建连接。 */
  readonly isNewConnection?: boolean
  readonly body?: unknown
  /** 期望的成功状态码，默认 200。 */
  readonly expectedStatus?: number
  readonly timeoutMs?: number
}

function networkFailure(cause?: unknown): HttpOperationError {
  return new HttpOperationError(
    'network-failure',
    'Cannot reach the device. Check that it is on the same network and its service is on.',
    cause,
  )
}

function cancelled(): HttpOperationError {
  return new HttpOperationError('network-failure', 'The request was cancelled.')
}

function idle(): HttpOperationError {
  return new HttpOperationError('timeout', 'The device stopped responding.')
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BATCH_LIMITS.maxJsonBytes) {
      response.destroy()
      throw new HttpOperationError('resource-limit', 'The response exceeds the size limit.')
    }
    chunks.push(buffer)
  }
  if (!response.complete) {
    throw networkFailure()
  }
  return Buffer.concat(chunks, size)
}

/** 读完应答并取出成功的 value；对方答复错误时抛出同样错误码的错误。 */
async function readReply(response: IncomingMessage, expectedStatus: number): Promise<unknown> {
  const bytes = await readBody(response)
  let parsed: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    parsed = JSON.parse(text)
    inspectJsonKeys(text)
  } catch (cause) {
    throw new HttpOperationError('invalid-request', 'The device response is not valid JSON.', cause)
  }
  if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
    if (parsed.status === 'error' && 'error' in parsed && isOperationError(parsed.error)) {
      throw new HttpOperationError(parsed.error.code, parsed.error.message)
    }
    if (
      parsed.status === 'success' &&
      'value' in parsed &&
      response.statusCode === expectedStatus
    ) {
      return parsed.value
    }
  }
  throw new HttpOperationError('invalid-request', 'The device response format is invalid.')
}

function asHttpError(error: unknown): HttpOperationError {
  return error instanceof HttpOperationError ? error : networkFailure(error)
}

/** 访问一台监听方 HTTP 接口的客户端，固定到一个源地址（`http://IP:端口`）。 */
export class DialerHttpClient {
  constructor(readonly origin: string) {}

  private headers(options: DialerRequestOptions): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = { accept: 'application/json' }
    if (options.sessionId) {
      headers[HTTP_HEADERS.sessionId] = options.sessionId
    }
    if (options.deviceId) {
      headers[SYNC_DEVICE_HEADER] = options.deviceId
    }
    return headers
  }

  /**
   * 发一次 JSON 请求，返回成功应答的 value。
   *
   * @throws HttpOperationError 连不上、超时、响应格式不对或状态码不是 expectedStatus 时抛出；
   *   对方答复错误时抛出，错误码和对方的一致。
   */
  json(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: DialerJsonOptions = {},
  ): Promise<unknown> {
    const url = new URL(path, this.origin)
    const body =
      options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8')
    const headers = this.headers(options)
    if (options.isNewConnection) {
      headers['x-sync-connect'] = '1'
    }
    if (body) {
      headers['content-type'] = 'application/json; charset=utf-8'
      headers['content-length'] = body.length
    }
    const timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let isSettled = false
      const settle = (error: Error | null, value?: unknown): void => {
        if (isSettled) {
          return
        }
        isSettled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (error) {
          request.destroy()
          reject(error)
        } else {
          resolve(value)
        }
      }
      const abort = (): void => settle(cancelled())
      const timer = setTimeout(
        () => settle(new HttpOperationError('timeout', 'The device did not respond in time.')),
        timeoutMs,
      )
      const request = httpRequest(
        url,
        { method, headers, agent: false, setHost: true },
        (response) => {
          readReply(response, options.expectedStatus ?? 200).then(
            (value) => settle(null, value),
            (error: unknown) => settle(asHttpError(error)),
          )
        },
      )
      request.on('error', (error) => settle(networkFailure(error)))
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      request.end(body ?? undefined)
    })
  }

  /**
   * 以 chunked 方式 PUT 一份 tar.gz 内容，返回 202 应答的 value。write 把内容写进请求并结束它。
   * 对方在内容收完前就答复时（通常是错误），停止写入并按对方的答复结束。
   * 60 秒没有收发任何数据时按超时结束。
   *
   * @throws HttpOperationError 连不上、超时、取消或对方答复错误时抛出；write 先失败时抛出它的错误。
   */
  upload(
    path: string,
    options: DialerRequestOptions,
    write: (destination: Writable) => Promise<void>,
  ): Promise<unknown> {
    const url = new URL(path, this.origin)
    const headers = this.headers(options)
    headers['content-type'] = BATCH_ARCHIVE.contentType
    headers['transfer-encoding'] = 'chunked'
    return new Promise((resolve, reject) => {
      let isSettled = false
      let request: ClientRequest | null = null
      const settle = (error: unknown, value?: unknown): void => {
        if (isSettled) {
          return
        }
        isSettled = true
        options.signal?.removeEventListener('abort', abort)
        if (error !== null) {
          request?.destroy()
          reject(error instanceof Error ? error : networkFailure(error))
        } else {
          resolve(value)
        }
      }
      const abort = (): void => settle(cancelled())
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      const current = httpRequest(url, { method: 'PUT', headers, agent: false, setHost: true })
      request = current
      current.setTimeout(BATCH_TIMEOUTS_MS.networkIdle, () => settle(idle()))
      current.on('error', (error) => settle(networkFailure(error)))
      let hasResponse = false
      current.on('response', (response) => {
        hasResponse = true
        response.setTimeout(BATCH_TIMEOUTS_MS.networkIdle, () => response.destroy(idle()))
        readReply(response, 202).then(
          (value) => settle(null, value),
          (error: unknown) => settle(asHttpError(error)),
        )
      })
      write(current).catch((error: unknown) => {
        // 对方已经答复时，写入多半是因为连接被关掉而失败，以对方的答复为准。
        if (!hasResponse) {
          settle(error)
        }
      })
    })
  }

  /**
   * GET 一份 tar.gz 内容，返回应答流；调用方读完或 destroy 它。对方答复错误时读出错误抛出。
   * 收到应答头之前 8 秒、之后 60 秒没有数据时按超时结束；signal 中断时销毁连接。
   *
   * @throws HttpOperationError 连不上、超时、取消、内容类型不对或对方答复错误时抛出。
   */
  download(path: string, options: DialerRequestOptions): Promise<IncomingMessage> {
    const url = new URL(path, this.origin)
    const headers = this.headers(options)
    headers.accept = `${BATCH_ARCHIVE.contentType}, application/json`
    return new Promise((resolve, reject) => {
      let isSettled = false
      const settle = (error: Error | null, value?: IncomingMessage): void => {
        if (isSettled) {
          return
        }
        isSettled = true
        clearTimeout(timer)
        if (error) {
          options.signal?.removeEventListener('abort', abort)
          request.destroy()
          reject(error)
        } else if (value) {
          resolve(value)
        }
      }
      // 应答流交给调用方后，中断改为销毁连接，读取方从流的错误得知。
      const abort = (): void => {
        if (isSettled) {
          request.destroy(cancelled())
        } else {
          settle(cancelled())
        }
      }
      const timer = setTimeout(
        () => settle(new HttpOperationError('timeout', 'The device did not respond in time.')),
        JSON_TIMEOUT_MS,
      )
      const request = httpRequest(url, { method: 'GET', headers, agent: false, setHost: true })
      request.on('error', (error) => settle(networkFailure(error)))
      request.on('close', () => options.signal?.removeEventListener('abort', abort))
      request.on('response', (response) => {
        if (
          response.statusCode === 200 &&
          response.headers['content-type'] === BATCH_ARCHIVE.contentType
        ) {
          response.setTimeout(BATCH_TIMEOUTS_MS.networkIdle, () => response.destroy(idle()))
          settle(null, response)
          return
        }
        readReply(response, 200).then(
          () =>
            settle(
              new HttpOperationError('invalid-request', 'The device content type is invalid.'),
            ),
          (error: unknown) => settle(asHttpError(error)),
        )
      })
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      request.end()
    })
  }
}
