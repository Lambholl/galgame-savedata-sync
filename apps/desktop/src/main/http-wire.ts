import type { IncomingMessage, ServerResponse } from 'node:http'
import { BATCH_LIMITS, HTTP_ERROR_STATUS, isOpaqueId } from '@savedata-sync/shared'
import type { OperationResult } from '@savedata-sync/shared'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 解码一次的封闭路由；不使用会归一化点段的 URL 路径解析。 */
export interface HttpRoute {
  readonly kind:
    'device' | 'roots' | 'entries' | 'downloads' | 'uploads' | 'manifest' | 'content' | 'transfer'
  readonly id: string | null
  readonly parentId: string | null
}

function invalid(): never {
  throw new HttpOperationError('invalid-request', 'HTTP 请求格式无效。')
}

/** 唯一头名按不区分大小写检查；拒绝编码、Range 和歧义定界。 */
export function inspectHttpRequest(request: IncomingMessage): HttpRoute {
  const names = new Set<string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase()
    if (!name || names.has(name)) invalid()
    names.add(name)
  }
  if (!names.has('host') || names.has('content-encoding') || names.has('range')) invalid()
  const length = request.headers['content-length']
  const encoding = request.headers['transfer-encoding']
  if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9]\d*)$/.test(length)))
    invalid()
  if (encoding !== undefined && (encoding !== 'chunked' || length !== undefined)) invalid()
  const url = request.url ?? ''
  if (!url.startsWith('/') || url.startsWith('//') || url.length > 4096 || /[#\\\s]/.test(url))
    invalid()
  const parts = url.split('?')
  if (parts.length > 2) invalid()
  let segments: string[]
  const query = new Map<string, string>()
  try {
    segments = (parts[0] ?? '').split('/').slice(1).map(decodeURIComponent)
    if (parts.length === 2) {
      for (const field of (parts[1] ?? '').split('&')) {
        const pair = field.split('=')
        if (pair.length !== 2) invalid()
        const key = decodeURIComponent(pair[0] ?? '')
        const value = decodeURIComponent((pair[1] ?? '').replaceAll('+', ' '))
        if (key !== 'parentId' || query.has(key) || !isOpaqueId(value)) invalid()
        query.set(key, value)
      }
    }
  } catch (error) {
    throw new HttpOperationError('invalid-request', 'HTTP 路由编码无效。', error)
  }
  const [version, resource, id, action] = segments
  const method = request.method
  let kind: HttpRoute['kind']
  if (version !== 'v1') invalid()
  if (segments.length === 2 && resource === 'device' && method === 'GET') kind = 'device'
  else if (segments.length === 2 && resource === 'roots' && method === 'GET') kind = 'roots'
  else if (
    segments.length === 4 &&
    resource === 'roots' &&
    action === 'entries' &&
    method === 'GET' &&
    isOpaqueId(id)
  )
    kind = 'entries'
  else if (
    segments.length === 3 &&
    resource === 'transfers' &&
    (id === 'downloads' || id === 'uploads') &&
    method === 'POST'
  )
    kind = id
  else if (
    resource === 'transfers' &&
    isOpaqueId(id) &&
    segments.length === 3 &&
    (method === 'GET' || method === 'DELETE')
  )
    kind = 'transfer'
  else if (
    resource === 'transfers' &&
    isOpaqueId(id) &&
    segments.length === 4 &&
    ((method === 'GET' && (action === 'manifest' || action === 'content')) ||
      (method === 'PUT' && action === 'content'))
  )
    kind = action
  else invalid()
  if (kind !== 'entries' && query.size > 0) invalid()
  if (method === 'PUT' && kind === 'content' && (encoding !== undefined || length === undefined))
    invalid()
  if (
    kind !== 'downloads' &&
    kind !== 'uploads' &&
    !(method === 'PUT' && kind === 'content') &&
    (encoding !== undefined || (length !== undefined && length !== '0'))
  )
    invalid()
  return { kind, id: id ?? null, parentId: query.get('parentId') ?? null }
}

// JSON.parse 负责完整语法；第二遍只核对所有层级的解码键和深度，结果核对前不交给业务。
function inspectJsonKeys(text: string): void {
  let position = 0
  const skip = (): void => {
    while (/\s/.test(text[position] ?? '') && position < text.length) position++
  }
  const string = (): string => {
    const start = position++
    while (position < text.length) {
      const character = text[position++]
      if (character === '\\') position++
      else if (character === '"') return JSON.parse(text.slice(start, position)) as string
    }
    return invalid()
  }
  const value = (depth: number): void => {
    if (depth > 128) invalid()
    skip()
    const character = text[position]
    if (character === '"') {
      string()
      return
    }
    if (character === '{' || character === '[') {
      const object = character === '{'
      const end = object ? '}' : ']'
      const keys = new Set<string>()
      position++
      skip()
      if (text[position] === end) {
        position++
        return
      }
      while (position < text.length) {
        if (object) {
          skip()
          const key = string()
          if (keys.has(key)) invalid()
          keys.add(key)
          skip()
          position++
        }
        value(depth + 1)
        skip()
        if (text[position++] === end) return
      }
      invalid()
    }
    while (position < text.length && !/[\s,}\]]/.test(text[position] ?? '')) position++
  }
  value(0)
}

/** 控制 JSON 最多 8 MiB，严格 UTF-8、无重复键/尾随 trailer；不接管文件内容。 */
export async function readHttpJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type']
  if (typeof type !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type))
    invalid()
  const length = request.headers['content-length']
  if (length !== undefined && Number(length) > BATCH_LIMITS.maxJsonBytes)
    throw new HttpOperationError('resource-limit', 'JSON 请求超过资源预算。')
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (!Buffer.isBuffer(chunk)) invalid()
      size += chunk.length
      if (size > BATCH_LIMITS.maxJsonBytes)
        throw new HttpOperationError('resource-limit', 'JSON 请求超过资源预算。')
      chunks.push(chunk)
    }
    if (!request.complete || request.rawTrailers.length > 0) invalid()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, size),
    )
    const result: unknown = JSON.parse(text)
    inspectJsonKeys(text)
    return result
  } catch (error) {
    if (error instanceof HttpOperationError) throw error
    throw new HttpOperationError('invalid-request', 'JSON 请求损坏或未完整结束。', error)
  }
}

/** JSON 响应同样计 UTF-8 字节；头发出前完成序列化，超限以稳定错误返回。 */
export function sendHttpJson(
  response: ServerResponse,
  status: number,
  result: OperationResult<unknown>,
): void {
  if (response.destroyed) return
  const body = Buffer.from(JSON.stringify(result), 'utf8')
  if (body.length > BATCH_LIMITS.maxJsonBytes)
    throw new HttpOperationError('resource-limit', 'JSON 响应超过资源预算。')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** 归档响应开始后只能关闭连接，不能把错误 JSON 拼入 gzip 数据体。 */
export function sendHttpFailure(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return
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
