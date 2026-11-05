import { PROTOCOL_VERSION } from './contracts.ts'
import type { OperationErrorCode } from './contracts.ts'

/** 会话和压缩体校验的 HTTP 头；文件名只放 JSON，不放原始 HTTP 头。 */
export const HTTP_HEADERS = {
  sessionId: 'x-sync-session-id',
  archiveSha256: 'x-archive-sha256',
} as const

/** 固定路由和路由模板；适配器要校验参数并编码每一段，不能直接代入任意路径。 */
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

/** 错误码到 HTTP 状态的映射。网络失败发生在本地，没有 HTTP 状态；取消不是错误码，用任务结果表示。 */
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

/** 判断协议版本是否受支持：只接受当前的数字版本。 */
export function isProtocolVersionSupported(value: unknown): value is typeof PROTOCOL_VERSION {
  return value === PROTOCOL_VERSION
}

/** 校验不透明 ID（设备、根、条目、任务）：1 到 128 个 URL 安全 ASCII 字符，不是文件名或 content URI。 */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9]/.test(value) &&
    !/[^A-Za-z0-9_-]/.test(value)
  )
}

/** 校验小写 SHA-256 的格式，不计算或确认文件内容。 */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value)
}

/**
 * 校验新建文件用的单文件名：两端都能表示，最多 255 个 UTF-16 码元。
 * 拒绝路径、控制字符、Windows 保留名称和尾部的点或空格；输入不改写、不归一化。
 * 通过校验不表示提供者一定能创建；实际能力、名称竞争和越界由适配器检查。
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
