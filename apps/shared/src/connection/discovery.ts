import type { DeviceDescriptor } from '../protocol/contracts.ts'
import { PROTOCOL_VERSION } from '../protocol/contracts.ts'
import { isOpaqueId } from '../protocol/protocol.ts'
import { isRecord } from '../validation/data-validation.ts'
import { OperationFailure } from '../result.ts'

/**
 * 监听方在局域网广播的 DNS-SD 服务（RFC 6763）。
 * name 和 protocol 给按名称注册的库使用，type 给 Android NsdManager 这类要求完整服务类型的接口使用。
 */
export const DISCOVERY_SERVICE = {
  name: 'savedata-sync',
  protocol: 'tcp',
  type: '_savedata-sync._tcp',
} as const

/** DNS-SD 实例名的最大长度：一个 DNS 标签最多 63 个 UTF-8 字节。 */
const MAX_INSTANCE_NAME_BYTES = 63

/** TXT 记录里的身份字段，由监听方广播、拨号方解析。键名按 RFC 6763 的建议不超过 9 个字符。 */
export interface DiscoveryTxtRecord {
  /** 协议版本，十进制字符串。 */
  readonly v: string
  /** 监听方的稳定设备 ID。 */
  readonly id: string
  /** 监听方的平台。 */
  readonly pf: DeviceDescriptor['platform']
}

/** 从 TXT 记录读出的监听方身份。显示名取 DNS-SD 实例名，地址和端口取 SRV 与 A 记录。 */
export interface DiscoveredIdentity {
  readonly deviceId: string
  readonly platform: DeviceDescriptor['platform']
}

/**
 * 解析 TXT 记录的结果。
 * unsupported-version 表示对端协议版本不同，发现列表可以把它显示为需要更新；invalid 表示 TXT 缺少字段或字段不合法。
 */
export type DiscoveryTxtResult =
  | { readonly status: 'valid'; readonly identity: DiscoveredIdentity }
  | { readonly status: 'unsupported-version' }
  | { readonly status: 'invalid' }

/**
 * 生成监听方广播用的 TXT 记录。
 * 设备 ID 不合法时抛出 invalid-request 的 OperationFailure。
 */
export function createDiscoveryTxt(
  device: Pick<DeviceDescriptor, 'deviceId' | 'platform'>,
): DiscoveryTxtRecord {
  if (!isOpaqueId(device.deviceId)) {
    throw new OperationFailure('invalid-request', 'The device ID cannot be advertised.')
  }
  return { v: String(PROTOCOL_VERSION), id: device.deviceId, pf: device.platform }
}

function utf8Length(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
}

/**
 * 把设备显示名截成 DNS-SD 实例名：去掉首尾空白，按 Unicode 码位截到 63 个 UTF-8 字节以内。
 * 局域网里实例名重名时，系统或广播库会自动加后缀，因此实例名只用于显示，不能当作设备身份。
 */
export function createDiscoveryInstanceName(displayName: string): string {
  let name = '',
    bytes = 0
  for (const character of displayName.trim()) {
    bytes += utf8Length(character)
    if (bytes > MAX_INSTANCE_NAME_BYTES) {
      break
    }
    name += character
  }
  return name
}

/** 按 RFC 6763 不区分大小写地读取 TXT 字段；同一个键出现多次时返回 null。 */
function readTxtField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const matches = Object.keys(record).filter((name) => name.toLowerCase() === key)
  const value = matches.length === 1 ? record[matches[0] ?? ''] : undefined
  return typeof value === 'string' ? value : null
}

/**
 * 解析拨号方发现的 TXT 记录。输入是平台广播库或原生桥给出的键值对象，值须是字符串。
 * 未知字段被忽略，同一协议版本可以往 TXT 里加字段而不影响已发布的应用；协议版本先于其他字段检查。
 */
export function parseDiscoveryTxt(record: unknown): DiscoveryTxtResult {
  if (!isRecord(record)) {
    return { status: 'invalid' }
  }
  const version = readTxtField(record, 'v')
  if (version === null || !/^[1-9]\d{0,5}$/.test(version)) {
    return { status: 'invalid' }
  }
  if (Number(version) !== PROTOCOL_VERSION) {
    return { status: 'unsupported-version' }
  }
  const deviceId = readTxtField(record, 'id'),
    platform = readTxtField(record, 'pf')
  if (!isOpaqueId(deviceId) || (platform !== 'windows' && platform !== 'android')) {
    return { status: 'invalid' }
  }
  return { status: 'valid', identity: { deviceId, platform } }
}
