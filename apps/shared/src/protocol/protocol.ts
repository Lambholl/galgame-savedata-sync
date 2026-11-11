import { PROTOCOL_VERSION } from './contracts.ts'
import type { OperationErrorCode } from './contracts.ts'

/** 会话和压缩体校验使用的 HTTP 头。 */
export const HTTP_HEADERS = {
  sessionId: 'x-sync-session-id',
  archiveSha256: 'x-archive-sha256',
} as const

/** 固定路由和路由模板；模板参数要先校验，再逐段编码代入。 */
export const HTTP_ROUTES = {
  device: '/v1/device',
  roots: '/v1/roots',
  entries: '/v1/roots/{rootId}/entries',
  downloads: '/v1/transfers/downloads',
  uploads: '/v1/transfers/uploads',
  manifest: '/v1/transfers/{transferId}/manifest',
  content: '/v1/transfers/{transferId}/content',
  transfer: '/v1/transfers/{transferId}',
} as const

/** 错误码对应的 HTTP 状态。 */
export const HTTP_ERROR_STATUS = {
  'invalid-request': 400,
  'protocol-mismatch': 409,
  'session-mismatch': 409,
  'task-conflict': 409,
  'plan-expired': 409,
  'invalid-archive': 422,
  'resource-limit': 413,
  busy: 429,
  timeout: 408,
  'permission-denied': 403,
  'authorization-expired': 403,
  'not-found': 404,
  'not-readable': 403,
  'unsupported-operation': 501,
  'name-conflict': 409,
  'path-outside-root': 403,
  'source-changed': 409,
  'checksum-mismatch': 422,
  'network-failure': null,
  'insufficient-space': 507,
  'io-failure': 500,
  'cleanup-failed': 500,
  'result-unknown': 404,
} as const satisfies Readonly<Record<OperationErrorCode, number | null>>

/** 判断协议版本是否等于当前的 PROTOCOL_VERSION。 */
export function isProtocolVersionSupported(value: unknown): value is typeof PROTOCOL_VERSION {
  return value === PROTOCOL_VERSION
}

/** 校验不透明 ID（设备、根、条目、任务）：1 到 128 个 URL 安全 ASCII 字符。 */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9]/.test(value) &&
    !/[^A-Za-z0-9_-]/.test(value)
  )
}

/** 校验字符串是否为 64 位小写十六进制的 SHA-256。 */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value)
}

/**
 * 校验新建文件用的单文件名：两端都能表示，最多 255 个 UTF-16 码元。
 * 拒绝路径、控制字符、Windows 保留名称和尾部的点或空格。
 */
export function isPortableFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[<>:"/\\|?*\uD800-\uDFFF]/u.test(value) &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !/[. ]$/.test(value) &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?:\.|$)/i.test(value)
  )
}
