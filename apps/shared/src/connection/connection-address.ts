import { normalizeHttpAddress } from '../library/library.ts'
import { OperationFailure } from '../result.ts'

/** 二维码最多携带的候选 IPv4 地址数，限制二维码的尺寸和拨号方逐个尝试的次数。 */
export const MAX_CANDIDATE_ADDRESSES = 8

/** 校验点分十进制 IPv4 地址：四段 0–255，不接受前导零、空白和端口。 */
export function isIpv4Address(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) &&
    value.split('.').every((part) => Number(part) <= 255)
  )
}

/** 校验监听端口：1–65535 的整数。 */
export function isListeningPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * 把监听方的 IPv4 地址和端口转成拨号方依次尝试的内部 HTTP 地址（`http://ip:port`）。
 * 保留输入顺序，监听方把推荐地址放在第一位；非 IPv4 的值（如 DNS-SD 解析出的 IPv6）被跳过，重复地址只保留第一次。
 * 返回空数组表示没有可用的 IPv4 地址；端口无效时抛出 invalid-request 的 OperationFailure。
 */
export function createConnectionCandidates(
  addresses: readonly string[],
  port: number,
): readonly string[] {
  if (!isListeningPort(port)) {
    throw new OperationFailure('invalid-request', 'The listening port is invalid.')
  }
  const unique = [...new Set(addresses.filter(isIpv4Address))]
  return unique.map((address) => normalizeHttpAddress(`${address}:${port}`))
}
