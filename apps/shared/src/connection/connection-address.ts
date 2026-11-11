import { normalizeHttpAddress } from '../library/library.ts'
import { OperationFailure } from '../result.ts'

/** 连接二维码最多携带的 IPv4 地址数。 */
export const MAX_CANDIDATE_ADDRESSES = 8

/** 校验点分十进制 IPv4 地址：四段 0–255，拒绝前导零、空白和端口。 */
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
 * 把 IPv4 地址和端口转成 `http://ip:port` 形式的候选地址。
 *
 * @param addresses 按输入顺序输出；跳过非 IPv4 的值，重复地址只保留第一个。
 * @returns 没有可用的 IPv4 地址时返回空数组。
 * @throws OperationFailure 端口无效时抛出，code 为 invalid-request。
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
