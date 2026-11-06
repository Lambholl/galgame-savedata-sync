import { PROTOCOL_VERSION } from '../protocol/contracts.ts'
import { isOpaqueId } from '../protocol/protocol.ts'
import { OperationFailure } from '../result.ts'
import { isIpv4Address, isListeningPort, MAX_CANDIDATE_ADDRESSES } from './connection-address.ts'

/** 连接二维码文本的前缀；文本格式为 `savedata-sync://connect?v=1&id=<设备 ID>&p=<端口>&a=<IPv4>,<IPv4>`。 */
export const CONNECTION_QR_PREFIX = 'savedata-sync://connect?'

/** 二维码文本的最大长度，超过的文本不解析。8 个地址、128 位设备 ID 的文本不超过 300 个字符。 */
const MAX_QR_TEXT_LENGTH = 512

/**
 * 连接二维码的内容，由监听方显示、移动端扫码读取。
 * 二维码只用来找到监听方的地址，连接后仍以 `/v1/device` 返回的设备 ID 为准。
 */
export interface ConnectionQrPayload {
  /** 监听方的稳定设备 ID。 */
  readonly deviceId: string
  /** 监听方的 HTTP 端口。 */
  readonly port: number
  /** 监听方的 IPv4 地址，按推荐顺序排列，1–8 个且不重复。 */
  readonly addresses: readonly string[]
}

/**
 * 解析二维码的结果。
 * unsupported-version 表示二维码来自协议版本不同的应用，其余字段不再解析；invalid 表示不是本应用的连接二维码或内容不合法。
 */
export type ConnectionQrResult =
  | { readonly status: 'valid'; readonly payload: ConnectionQrPayload }
  | { readonly status: 'unsupported-version' }
  | { readonly status: 'invalid' }

function hasValidAddresses(addresses: readonly unknown[]): boolean {
  return (
    addresses.length > 0 &&
    addresses.length <= MAX_CANDIDATE_ADDRESSES &&
    addresses.every(isIpv4Address) &&
    new Set(addresses).size === addresses.length
  )
}

/**
 * 生成监听方显示的连接二维码文本。
 * 设备 ID 只含 URL 安全字符，IPv4 和端口只含数字和点，因此各字段不需要百分号编码。
 * 设备 ID、端口或地址列表不合法时抛出 invalid-request 的 OperationFailure。
 */
export function createConnectionQrText(payload: ConnectionQrPayload): string {
  if (
    !isOpaqueId(payload.deviceId) ||
    !isListeningPort(payload.port) ||
    !hasValidAddresses(payload.addresses)
  ) {
    throw new OperationFailure('invalid-request', 'The connection QR code content is invalid.')
  }
  return `${CONNECTION_QR_PREFIX}v=${PROTOCOL_VERSION}&id=${payload.deviceId}&p=${payload.port}&a=${payload.addresses.join(',')}`
}

function readQueryFields(query: string): ReadonlyMap<string, string> | null {
  const fields = new Map<string, string>()
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      return null
    }
    const key = pair.slice(0, separator)
    if (fields.has(key)) {
      return null
    }
    fields.set(key, pair.slice(separator + 1))
  }
  return fields
}

/**
 * 解析移动端扫到的二维码文本。
 * 前缀和字段名区分大小写，字段必须恰好是 v、id、p、a 且各出现一次。
 * 协议版本先于其他字段检查，以后的版本可以改变其余字段。
 */
export function parseConnectionQrText(text: unknown): ConnectionQrResult {
  if (
    typeof text !== 'string' ||
    text.length > MAX_QR_TEXT_LENGTH ||
    !text.startsWith(CONNECTION_QR_PREFIX)
  ) {
    return { status: 'invalid' }
  }
  const fields = readQueryFields(text.slice(CONNECTION_QR_PREFIX.length))
  const version = fields?.get('v')
  if (!fields || version === undefined || !/^[1-9]\d{0,5}$/.test(version)) {
    return { status: 'invalid' }
  }
  if (Number(version) !== PROTOCOL_VERSION) {
    return { status: 'unsupported-version' }
  }
  const deviceId = fields.get('id'),
    port = fields.get('p'),
    addresses = fields.get('a')?.split(',') ?? []
  if (
    fields.size !== 4 ||
    !isOpaqueId(deviceId) ||
    port === undefined ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    !isListeningPort(Number(port)) ||
    !hasValidAddresses(addresses)
  ) {
    return { status: 'invalid' }
  }
  return { status: 'valid', payload: { deviceId, port: Number(port), addresses } }
}
