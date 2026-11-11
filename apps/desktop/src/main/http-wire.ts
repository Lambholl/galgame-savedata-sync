import type { IncomingMessage, ServerResponse } from 'node:http'
import { BATCH_LIMITS, HTTP_ERROR_STATUS, isOpaqueId } from '@savedata-sync/shared'
import type { OperationResult } from '@savedata-sync/shared'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 解析后的路由，路径段只解码一次。 */
export interface HttpRoute {
  readonly kind:
    | 'device'
    | 'roots'
    | 'entries'
    | 'downloads'
    | 'uploads'
    | 'manifest'
    | 'content'
    | 'transfer'
    | 'catalog'
    | 'sync-capabilities'
    | 'sync-scans'
    | 'sync-scan'
    | 'sync-project'
    | 'sync-jobs'
    | 'sync-job'
    | 'sync-job-manifest'
    | 'sync-job-content'
  readonly id: string | null
  readonly parentId: string | null
}

function invalid(): never {
  throw new HttpOperationError('invalid-request', 'The HTTP request format is invalid.')
}

/**
 * 检查请求头并解析路由；头名不区分大小写。
 *
 * @throws HttpOperationError 头名重复，带 Content-Encoding 或 Range，或同时带 Content-Length 和 chunked 时抛出。
 */
export function inspectHttpRequest(request: IncomingMessage): HttpRoute {
  const names = new Set<string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase()
    if (!name || names.has(name)) {
      invalid()
    }
    names.add(name)
  }
  if (!names.has('host') || names.has('content-encoding') || names.has('range')) {
    invalid()
  }
  const length = request.headers['content-length']
  const encoding = request.headers['transfer-encoding']
  if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9]\d*)$/.test(length))) {
    invalid()
  }
  if (encoding !== undefined && (encoding !== 'chunked' || length !== undefined)) {
    invalid()
  }
  const url = request.url ?? ''
  if (!url.startsWith('/') || url.startsWith('//') || url.length > 4096 || /[#\\\s]/.test(url)) {
    invalid()
  }
  const parts = url.split('?')
  if (parts.length > 2) {
    invalid()
  }
  let segments: string[]
  const query = new Map<string, string>()
  try {
    segments = (parts[0] ?? '').split('/').slice(1).map(decodeURIComponent)
    if (parts.length === 2) {
      for (const field of (parts[1] ?? '').split('&')) {
        const pair = field.split('=')
        if (pair.length !== 2) {
          invalid()
        }
        const key = decodeURIComponent(pair[0] ?? '')
        const value = decodeURIComponent((pair[1] ?? '').replaceAll('+', ' '))
        if (key !== 'parentId' || query.has(key) || !isOpaqueId(value)) {
          invalid()
        }
        query.set(key, value)
      }
    }
  } catch (error) {
    throw new HttpOperationError('invalid-request', 'The HTTP route encoding is invalid.', error)
  }
  const [version, resource, id, action] = segments
  const detail = segments[4]
  const method = request.method
  let kind: HttpRoute['kind']
  if (version !== 'v1') {
    invalid()
  }
  if (segments.length === 2 && resource === 'device' && method === 'GET') {
    kind = 'device'
  } else if (
    resource === 'sync' &&
    segments.length === 3 &&
    id === 'capabilities' &&
    method === 'GET'
  ) {
    kind = 'sync-capabilities'
  } else if (resource === 'sync' && segments.length === 3 && id === 'scans' && method === 'POST') {
    kind = 'sync-scans'
  } else if (
    resource === 'sync' &&
    segments.length === 4 &&
    id === 'scans' &&
    isOpaqueId(action) &&
    (method === 'GET' || method === 'DELETE')
  ) {
    kind = 'sync-scan'
  } else if (
    resource === 'sync' &&
    segments.length === 4 &&
    id === 'projects' &&
    isOpaqueId(action) &&
    method === 'GET'
  ) {
    kind = 'sync-project'
  } else if (resource === 'sync' && segments.length === 3 && id === 'jobs' && method === 'POST') {
    kind = 'sync-jobs'
  } else if (
    resource === 'sync' &&
    id === 'jobs' &&
    isOpaqueId(action) &&
    segments.length === 4 &&
    (method === 'GET' || method === 'DELETE')
  ) {
    kind = 'sync-job'
  } else if (
    resource === 'sync' &&
    id === 'jobs' &&
    isOpaqueId(action) &&
    segments.length === 5 &&
    ((detail === 'manifest' && (method === 'GET' || method === 'PUT')) ||
      (detail === 'content' && (method === 'GET' || method === 'PUT')))
  ) {
    kind = detail === 'manifest' ? 'sync-job-manifest' : 'sync-job-content'
  } else if (segments.length === 2 && resource === 'catalog' && method === 'POST') {
    kind = 'catalog'
  } else if (segments.length === 2 && resource === 'roots' && method === 'GET') {
    kind = 'roots'
  } else if (
    segments.length === 4 &&
    resource === 'roots' &&
    action === 'entries' &&
    method === 'GET' &&
    isOpaqueId(id)
  ) {
    kind = 'entries'
  } else if (
    segments.length === 3 &&
    resource === 'transfers' &&
    (id === 'downloads' || id === 'uploads') &&
    method === 'POST'
  ) {
    kind = id
  } else if (
    resource === 'transfers' &&
    isOpaqueId(id) &&
    segments.length === 3 &&
    (method === 'GET' || method === 'DELETE')
  ) {
    kind = 'transfer'
  } else if (
    resource === 'transfers' &&
    isOpaqueId(id) &&
    segments.length === 4 &&
    ((method === 'GET' && (action === 'manifest' || action === 'content')) ||
      (method === 'PUT' && action === 'content'))
  ) {
    kind = action
  } else {
    invalid()
  }
  if (kind !== 'entries' && query.size > 0) {
    invalid()
  }
  if (
    method === 'PUT' &&
    (kind === 'content' || kind === 'sync-job-content') &&
    (encoding !== undefined || length === undefined)
  ) {
    invalid()
  }
  if (
    kind !== 'downloads' &&
    kind !== 'uploads' &&
    kind !== 'catalog' &&
    kind !== 'sync-scans' &&
    kind !== 'sync-jobs' &&
    !(method === 'PUT' && kind === 'sync-job-manifest') &&
    !(method === 'PUT' && kind === 'sync-job-content') &&
    !(method === 'PUT' && kind === 'content') &&
    (encoding !== undefined || (length !== undefined && length !== '0'))
  ) {
    invalid()
  }
  return {
    kind,
    id: resource === 'sync' ? (action ?? null) : (id ?? null),
    parentId: query.get('parentId') ?? null,
  }
}

/**
 * 检查 JSON 文本各层对象的键和嵌套深度；text 已通过 JSON.parse。
 *
 * @throws HttpOperationError 有重复键或嵌套超过 128 层时抛出，错误码为 invalid-request。
 */
export function inspectJsonKeys(text: string): void {
  let position = 0
  const skip = (): void => {
    while (/\s/.test(text[position] ?? '') && position < text.length) {
      position++
    }
  }
  const string = (): string => {
    const start = position++
    while (position < text.length) {
      const character = text[position++]
      if (character === '\\') {
        position++
      } else if (character === '"') {
        return JSON.parse(text.slice(start, position)) as string
      }
    }
    return invalid()
  }
  const value = (depth: number): void => {
    if (depth > 128) {
      invalid()
    }
    skip()
    const character = text[position]
    if (character === '"') {
      string()
      return
    }
    if (character === '{' || character === '[') {
      const isObject = character === '{'
      const end = isObject ? '}' : ']'
      const keys = new Set<string>()
      position++
      skip()
      if (text[position] === end) {
        position++
        return
      }
      while (position < text.length) {
        if (isObject) {
          skip()
          const key = string()
          if (keys.has(key)) {
            invalid()
          }
          keys.add(key)
          skip()
          position++
        }
        value(depth + 1)
        skip()
        if (text[position++] === end) {
          return
        }
      }
      invalid()
    }
    while (position < text.length && !/[\s,}\]]/.test(text[position] ?? '')) {
      position++
    }
  }
  value(0)
}

/** 读取控制 JSON 请求体：最多 8 MiB，严格 UTF-8，不允许重复键和 trailer。 */
export async function readHttpJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type']
  if (typeof type !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type)) {
    invalid()
  }
  const length = request.headers['content-length']
  if (length !== undefined && Number(length) > BATCH_LIMITS.maxJsonBytes) {
    throw new HttpOperationError('resource-limit', 'The JSON request exceeds the resource budget.')
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (!Buffer.isBuffer(chunk)) {
        invalid()
      }
      size += chunk.length
      if (size > BATCH_LIMITS.maxJsonBytes) {
        throw new HttpOperationError(
          'resource-limit',
          'The JSON request exceeds the resource budget.',
        )
      }
      chunks.push(chunk)
    }
    if (!request.complete || request.rawTrailers.length > 0) {
      invalid()
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, size),
    )
    const result: unknown = JSON.parse(text)
    inspectJsonKeys(text)
    return result
  } catch (error) {
    if (error instanceof HttpOperationError) {
      throw error
    }
    throw new HttpOperationError(
      'invalid-request',
      'The JSON request is damaged or incomplete.',
      error,
    )
  }
}

/** 发送 JSON 响应，按 UTF-8 字节计长度；响应头发出前完成序列化，超限时返回稳定错误。 */
export function sendHttpJson(
  response: ServerResponse,
  status: number,
  result: OperationResult<unknown>,
): void {
  if (response.destroyed) {
    return
  }
  const body = Buffer.from(JSON.stringify(result), 'utf8')
  if (body.length > BATCH_LIMITS.maxJsonBytes) {
    throw new HttpOperationError('resource-limit', 'The JSON response exceeds the resource budget.')
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** 发送失败响应；响应头已经发出时直接关闭连接。 */
export function sendHttpFailure(response: ServerResponse, error: unknown): void {
  if (response.destroyed) {
    return
  }
  if (response.headersSent) {
    response.destroy()
    return
  }
  const failure = toHttpError(error).operationError
  response.setHeader('connection', 'close')
  sendHttpJson(response, HTTP_ERROR_STATUS[failure.code] ?? 500, {
    status: 'error',
    error: failure,
  })
}
