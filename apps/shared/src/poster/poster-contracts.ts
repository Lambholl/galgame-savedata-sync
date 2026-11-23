import type { DeviceDescriptor } from '../protocol/contracts.ts'
import { isRecord } from '../validation/data-validation.ts'

/** 封面搜索来源。 */
export type PosterSource = 'vndb' | 'nextmoe' | 'bangumi' | 'steam'

/** 全部封面搜索来源，按界面的显示顺序排列。 */
export const POSTER_SOURCES: readonly PosterSource[] = ['vndb', 'nextmoe', 'bangumi', 'steam']

/** 封面搜索的数量和大小上限，两端相同。 */
export const POSTER_LIMITS = {
  /** 一次搜索最多返回的候选数。 */
  maxSearchResults: 10,
  /** NextMoe 一部作品最多列出的封面数。 */
  maxWorkCovers: 100,
  /** JSON 响应体的最大长度，单位是 UTF-16 码元。执行器读到超过这个长度时按网络失败处理。 */
  maxJsonChars: 4 * 1024 * 1024,
  /** 下载或从本机选取的图片的最大字节数；超过时返回 resource-limit。 */
  maxImageBytes: 20 * 1024 * 1024,
  /** 保存的封面文件的最大字节数。 */
  maxSavedBytes: 1024 * 1024,
  /** 同时下载的预览图数量上限。 */
  maxPreviewDownloads: 4,
} as const

/** 执行器的超时，单位毫秒。 */
export const POSTER_TIMEOUTS_MS = {
  /** 建立连接的超时。 */
  connect: 15_000,
  /** 两次读到数据之间的超时。 */
  read: 20_000,
} as const

/** 执行器允许请求接口的主机。 */
export const POSTER_API_HOSTS: readonly string[] = [
  'api.vndb.org',
  'api.bgm.tv',
  'store.steampowered.com',
  'api.steampowered.com',
  'api.nextmoe.dev',
]

/** 执行器允许下载图片的主机。 */
export const POSTER_IMAGE_HOSTS: readonly string[] = [
  't.vndb.org',
  'lain.bgm.tv',
  'shared.akamai.steamstatic.com',
  'image.kungal.iloveren.link',
]

/** 交给执行器的一次接口请求。 */
export interface PosterHttpRequest {
  readonly method: 'GET' | 'POST'
  /** 完整的 https 地址，主机在 POSTER_API_HOSTS 里。 */
  readonly url: string
  /** 除 User-Agent 外的请求头；User-Agent 由执行器按 createPosterUserAgent 填写。 */
  readonly headers: Readonly<Record<string, string>>
  /** POST 的 UTF-8 请求体；GET 为 null。 */
  readonly body: string | null
}

/** 执行器收到的接口响应。 */
export interface PosterHttpResponse {
  /** HTTP 状态码。 */
  readonly status: number
  /** Content-Type 响应头；没有时为 null。 */
  readonly contentType: string | null
  /** 按 UTF-8 解码的响应体，最长 POSTER_LIMITS.maxJsonChars。 */
  readonly body: string
}

/**
 * 执行一次接口请求。
 *
 * @returns 收到任意 HTTP 状态码时 resolve。
 * @throws 连不上、超时、TLS 失败或响应体超过 POSTER_LIMITS.maxJsonChars 时 reject。
 */
export type PosterHttpExecutor = (request: PosterHttpRequest) => Promise<PosterHttpResponse>

/** 限流用的时钟。 */
export interface PosterClock {
  /** 当前时间，单位毫秒，只用来计算间隔。 */
  now(): number
  /** 等待 ms 毫秒后 resolve；ms 为 0 时也可以立即 resolve。 */
  wait(ms: number): Promise<void>
}

/** 候选的公共字段。 */
interface PosterCandidateBase {
  readonly source: PosterSource
  /** 来源里的条目 ID；NextMoe 的封面候选是封面 ID。同一次搜索内唯一。 */
  readonly id: string
  readonly title: string
  /** 原名或封面类别；与标题相同或没有时为 null。 */
  readonly subtitle: string | null
  /** 发售日期、开发商或尺寸，用 “ · ” 连接；没有时为 null。 */
  readonly detail: string | null
}

/** 可以直接下载的封面候选。 */
export interface PosterImageCandidate extends PosterCandidateBase {
  readonly kind: 'image'
  /** 预览用的图片地址，主机在 POSTER_IMAGE_HOSTS 里。 */
  readonly previewUrl: string
  /** 保存用的图片地址，主机在 POSTER_IMAGE_HOSTS 里；可以与 previewUrl 相同。 */
  readonly downloadUrl: string
}

/** NextMoe 的作品候选，选中后用 PosterSearchClient.listWorkCovers 列出这部作品的封面。 */
export interface PosterWorkCandidate extends PosterCandidateBase {
  readonly kind: 'work'
  readonly source: 'nextmoe'
  /** 作品的代表封面，主机在 POSTER_IMAGE_HOSTS 里；作品没有代表封面时为 null。 */
  readonly previewUrl: string | null
}

/** 一条搜索结果。 */
export type PosterCandidate = PosterImageCandidate | PosterWorkCandidate

/**
 * 封面搜索失败的原因。
 * network：连不上来源；rate-limited：来源限流；service-error：来源返回了其他非 2xx 状态；bad-response：响应格式不符。
 */
export type PosterSearchErrorCode = 'network' | 'rate-limited' | 'service-error' | 'bad-response'

/** 封面搜索失败。 */
export class PosterSearchError extends Error {
  readonly source: PosterSource
  readonly code: PosterSearchErrorCode

  constructor(
    source: PosterSource,
    code: PosterSearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PosterSearchError'
    this.source = source
    this.code = code
  }
}

/** 项目主页，写在 User-Agent 里。 */
const PROJECT_HOMEPAGE = 'https://github.com/Lambholl/galgame-savedata-sync'

const PLATFORM_NAMES: Readonly<Record<DeviceDescriptor['platform'], string>> = {
  windows: 'Windows',
  android: 'Android',
}

/**
 * 生成执行器使用的 User-Agent。
 *
 * @param appVersion 应用版本号，即 APP_VERSION。
 */
export function createPosterUserAgent(
  appVersion: string,
  platform: DeviceDescriptor['platform'],
): string {
  // Bangumi 要求非浏览器调用方的 User-Agent 带开发者 ID、应用名，分发的应用带版本号，开源项目带主页。
  return `Lambholl/galgame-savedata-sync/${appVersion} (${PLATFORM_NAMES[platform]}) (${PROJECT_HOMEPAGE})`
}

/** 取 https 地址的主机名（小写）；不是 https 地址时返回 null。 */
function httpsHost(url: string): string | null {
  const match = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/iu.exec(url)
  return match?.[1]?.toLowerCase() ?? null
}

/** 判断请求是否可以交给执行器：方法、https 和接口主机都符合。 */
export function isPosterRequestAllowed(request: PosterHttpRequest): boolean {
  const host = httpsHost(request.url)
  return (
    (request.method === 'GET' || request.method === 'POST') &&
    host !== null &&
    POSTER_API_HOSTS.includes(host) &&
    (request.method === 'POST') === (request.body !== null)
  )
}

/** 判断图片地址是否可以下载：https 且主机在 POSTER_IMAGE_HOSTS 里。 */
export function isPosterImageUrl(url: string): boolean {
  const host = httpsHost(url)
  return host !== null && POSTER_IMAGE_HOSTS.includes(host)
}

/** 请求头的最多条数。 */
const MAX_REQUEST_HEADERS = 16

/** 校验交给执行器的请求：字段格式正确，且符合 isPosterRequestAllowed。 */
export function isPosterHttpRequest(value: unknown): value is PosterHttpRequest {
  if (
    !isRecord(value) ||
    (value.method !== 'GET' && value.method !== 'POST') ||
    typeof value.url !== 'string' ||
    !isRecord(value.headers) ||
    (value.body !== null && typeof value.body !== 'string')
  ) {
    return false
  }
  const headers = Object.values(value.headers)
  return (
    headers.length <= MAX_REQUEST_HEADERS &&
    headers.every((header) => typeof header === 'string') &&
    isPosterRequestAllowed({
      method: value.method,
      url: value.url,
      headers: value.headers as Record<string, string>,
      body: value.body,
    })
  )
}

/** 校验执行器返回的响应。 */
export function isPosterHttpResponse(value: unknown): value is PosterHttpResponse {
  return (
    isRecord(value) &&
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599 &&
    (value.contentType === null || typeof value.contentType === 'string') &&
    typeof value.body === 'string' &&
    value.body.length <= POSTER_LIMITS.maxJsonChars
  )
}

/**
 * 由游戏名生成默认的搜索关键词：去掉 `[…]` 和 `【…】` 括起来的部分，合并空白。
 *
 * @returns 去掉后为空时返回去掉首尾空白的原名。
 */
export function createDefaultPosterKeyword(gameName: string): string {
  const keyword = gameName
    .replace(/\[[^\]]*\]|【[^】]*】/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return keyword === '' ? gameName.trim() : keyword
}

/** 下载或从本机选取的图片。 */
export interface PosterImageData {
  /** 图片的 MIME 类型，以 `image/` 开头。 */
  readonly mimeType: string
  /** base64 编码的图片内容，解码后不超过 POSTER_LIMITS.maxImageBytes。 */
  readonly data: string
}

/** 保存封面的结果。 */
export interface PosterSaveResult {
  /** 写进 LibraryGame.posterHash 的值。 */
  readonly posterHash: string
}

/** 读出的封面。 */
export interface PosterFileData {
  /** base64 编码的 WebP 内容。 */
  readonly data: string
}

/** 编码 byteCount 字节需要的 base64 长度。 */
function base64Length(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4
}

function isBase64(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= base64Length(maxBytes) &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  )
}

/** 校验封面 hash：64 位小写十六进制的 SHA-256。 */
export function isPosterHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

/** 校验下载或选取的图片。 */
export function isPosterImageData(value: unknown): value is PosterImageData {
  return (
    isRecord(value) &&
    typeof value.mimeType === 'string' &&
    /^image\/[a-z0-9.+-]+$/u.test(value.mimeType) &&
    isBase64(value.data, POSTER_LIMITS.maxImageBytes)
  )
}

/** 校验保存封面的结果。 */
export function isPosterSaveResult(value: unknown): value is PosterSaveResult {
  return isRecord(value) && isPosterHash(value.posterHash)
}

/** 校验读出的封面，也用来校验待保存的封面内容。 */
export function isPosterFileData(value: unknown): value is PosterFileData {
  return isRecord(value) && isBase64(value.data, POSTER_LIMITS.maxSavedBytes)
}
