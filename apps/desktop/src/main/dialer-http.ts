import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import {
  BATCH_LIMITS,
  HTTP_HEADERS,
  SYNC_DEVICE_HEADER,
  isOperationError,
} from '@savedata-sync/shared'
import { HttpOperationError } from './http-errors.ts'
import { inspectJsonKeys } from './http-wire.ts'

/** JSON 请求等应答的默认期限。 */
const JSON_TIMEOUT_MS = 8000

/** 一次 JSON 请求的选项。 */
export interface DialerJsonOptions {
  /** 监听方的会话 ID，放进 x-sync-session-id；不传时不带这个头。 */
  readonly sessionId?: string
  /** 本机设备 ID，放进 x-sync-device-id；不传时不带这个头。 */
  readonly deviceId?: string
  /** 为 true 时带 x-sync-connect: 1，表示新建连接。 */
  readonly isNewConnection?: boolean
  readonly body?: unknown
  /** 期望的成功状态码，默认 200。 */
  readonly expectedStatus?: number
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

function networkFailure(cause?: unknown): HttpOperationError {
  return new HttpOperationError(
    'network-failure',
    'Cannot reach the device. Check that it is on the same network and its service is on.',
    cause,
  )
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

/** 访问一台监听方 HTTP 接口的客户端，固定到一个源地址（`http://IP:端口`）。 */
export class DialerHttpClient {
  constructor(readonly origin: string) {}

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
    const headers: Record<string, string | number> = { accept: 'application/json' }
    if (options.sessionId) {
      headers[HTTP_HEADERS.sessionId] = options.sessionId
    }
    if (options.deviceId) {
      headers[SYNC_DEVICE_HEADER] = options.deviceId
    }
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
      const abort = (): void =>
        settle(new HttpOperationError('network-failure', 'The request was cancelled.'))
      const timer = setTimeout(
        () => settle(new HttpOperationError('timeout', 'The device did not respond in time.')),
        timeoutMs,
      )
      const request = httpRequest(
        url,
        { method, headers, agent: false, setHost: true },
        (response) => {
          readBody(response)
            .then((bytes) => {
              let parsed: unknown
              try {
                const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                  bytes,
                )
                parsed = JSON.parse(text)
                inspectJsonKeys(text)
              } catch (cause) {
                throw new HttpOperationError(
                  'invalid-request',
                  'The device response is not valid JSON.',
                  cause,
                )
              }
              if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
                if (
                  parsed.status === 'error' &&
                  'error' in parsed &&
                  isOperationError(parsed.error)
                ) {
                  throw new HttpOperationError(parsed.error.code, parsed.error.message)
                }
                if (
                  parsed.status === 'success' &&
                  'value' in parsed &&
                  response.statusCode === (options.expectedStatus ?? 200)
                ) {
                  return parsed.value
                }
              }
              throw new HttpOperationError(
                'invalid-request',
                'The device response format is invalid.',
              )
            })
            .then(
              (value) => settle(null, value),
              (error: unknown) =>
                settle(error instanceof HttpOperationError ? error : networkFailure(error)),
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
}
