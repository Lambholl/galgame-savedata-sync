import { PROTOCOL_VERSION } from './contracts.ts'
import type { OperationErrorCode } from './contracts.ts'

/** 协议头名不区分大小写；文件名只放 UTF-8 URL 查询参数，不放原始 HTTP 头。 */
export const HTTP_HEADERS = {
  contentSha256: 'x-content-sha256',
  expectedSha256: 'x-expected-sha256',
  expectedSizeBytes: 'x-expected-size-bytes',
} as const

/** 静态路由与模板；适配器需校验参数并编码每段，不能直接替换任意路径。 */
export const HTTP_ROUTES = {
  device: '/v1/device',
  roots: '/v1/roots',
  entries: '/v1/roots/{rootId}/entries',
  content: '/v1/roots/{rootId}/files/{entryId}/content',
  createFile: '/v1/roots/{rootId}/transfers/{transferId}',
  transfer: '/v1/transfers/{transferId}',
} as const

/** 网络失败发生在本地，没有可伪造的 HTTP 状态；取消使用任务结果，不使用 499。 */
export const HTTP_ERROR_STATUS = {
  'invalid-request': 400,
  'protocol-mismatch': 409,
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

/** 只接受当前确切数字版本；字符串、未来版本及不兼容响应均返回 false。 */
export function isProtocolVersionSupported(value: unknown): value is typeof PROTOCOL_VERSION {
  return value === PROTOCOL_VERSION
}

/** 设备/根/条目/任务 ID 为 1–128 个 URL 安全 ASCII 字符，不是文件名或 content URI。 */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9]/.test(value) &&
    !/[^A-Za-z0-9_-]/.test(value)
  )
}

/** 协议统一使用小写 SHA-256；这里只校验格式，不计算或确认文件内容。 */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value)
}

/**
 * 新建文件采用双端共同可表示的单文件名，最多 255 个 UTF-16 码元。
 * 拒绝路径、控制字符、Windows 保留名称及尾部点/空格；不改写或归一化输入。
 * 不表示提供者一定能创建该名称，实际能力、名称竞争和越界检查仍由适配器负责。
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
