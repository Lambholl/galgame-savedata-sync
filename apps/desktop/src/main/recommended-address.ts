import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CACHE_MS = 30_000

/** Windows 网卡的 IPv4 地址、默认网关及排序信息。 */
export interface NetworkAddressCandidate {
  readonly address: string
  readonly interfaceName: string
  /** 默认路由的下一跳。 */
  readonly gateway: string | null
  /** 网关与接口 metric 之和。 */
  readonly metric: number
}

interface ParsedGateway {
  readonly address: string
  metric: number | null
}

interface ParsedInterface {
  readonly interfaceName: string
  readonly addresses: string[]
  readonly gateways: ParsedGateway[]
  metric: number | null
}

function parseMetric(value: string): number {
  const metric = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(metric) || metric < 0) {
    throw new Error('Netsh returned an invalid network metric.')
  }
  return metric
}

/**
 * 解析英文 netsh IPv4 地址输出，保留各接口的多个 IP，采用 metric 最小的默认网关。
 * 返回未排序的候选；缺少接口头、地址格式错误或 metric 缺失时抛出错误。
 */
export function parseNetshAddresses(output: string): NetworkAddressCandidate[] {
  const interfaces: ParsedInterface[] = []
  let current: ParsedInterface | null = null
  let gateway: ParsedGateway | null = null
  for (const line of output.split(/\r?\n/)) {
    const header = /^Configuration for interface "(.*)"\s*$/.exec(line)
    if (header) {
      current = { interfaceName: header[1] ?? '', addresses: [], gateways: [], metric: null }
      interfaces.push(current)
      gateway = null
      continue
    }
    const field =
      /^\s*(IP Address|Default Gateway|Gateway Metric|InterfaceMetric):\s*(.*?)\s*$/.exec(line)
    if (!current || !field) {
      continue
    }
    const value = field[2] ?? ''
    if (field[1] === 'IP Address') {
      if (!isIPv4(value)) {
        throw new Error('Netsh returned an invalid IPv4 address.')
      }
      current.addresses.push(value)
    } else if (field[1] === 'Default Gateway') {
      gateway = null
      if (value && value !== '0.0.0.0') {
        if (!isIPv4(value)) {
          throw new Error('Netsh returned an invalid default gateway.')
        }
        gateway = { address: value, metric: null }
        current.gateways.push(gateway)
      }
    } else if (field[1] === 'Gateway Metric' && gateway) {
      gateway.metric = parseMetric(value)
    } else if (field[1] === 'InterfaceMetric') {
      current.metric = parseMetric(value)
    }
  }
  if (interfaces.length === 0) {
    throw new Error('Netsh returned an unrecognized address configuration.')
  }
  return interfaces.flatMap((item) => {
    if (item.addresses.length === 0) {
      return []
    }
    if (item.metric === null) {
      throw new Error('Netsh did not return an interface metric.')
    }
    const gateways = item.gateways.map((entry) => {
      if (entry.metric === null) {
        throw new Error('Netsh did not return a gateway metric.')
      }
      return { address: entry.address, metric: entry.metric }
    })
    const bestGateway = gateways.sort((a, b) => a.metric - b.metric)[0]
    const metric = item.metric + (bestGateway?.metric ?? 0)
    if (!Number.isSafeInteger(metric)) {
      throw new Error('Netsh returned an invalid combined metric.')
    }
    return item.addresses.map((address) => ({
      address,
      interfaceName: item.interfaceName,
      gateway: bestGateway?.address ?? null,
      metric,
    }))
  })
}

/**
 * 将候选地址按默认网关和 metric 排序，有默认网关的接口优先，返回过滤后的新数组。
 * 同级先比较 metric，再用接口名称和地址稳定排序；没有合适地址时返回空数组。
 */
export function rankNetworkAddresses(
  candidates: readonly NetworkAddressCandidate[],
): NetworkAddressCandidate[] {
  return candidates
    .filter((candidate) => {
      const address = candidate.address
      const firstOctet = Number(address.split('.')[0])
      return (
        isIPv4(address) &&
        firstOctet > 0 &&
        firstOctet < 224 &&
        firstOctet !== 127 &&
        !address.startsWith('169.254.')
      )
    })
    .sort(
      (a, b) =>
        Number(a.gateway === null) - Number(b.gateway === null) ||
        a.metric - b.metric ||
        a.interfaceName.localeCompare(b.interfaceName) ||
        a.address.localeCompare(b.address, 'en', { numeric: true }),
    )
}

/**
 * 异步运行英文 netsh 查询，并用 os.networkInterfaces 核对本机非回环 IPv4 地址。
 * 返回按默认网关和 metric 排序的地址。
 * 查询进程隐藏运行，最长等待 20 秒；系统查询失败、输出格式错误或非 Windows 平台时 reject。
 */
export async function queryNetworkAddresses(): Promise<NetworkAddressCandidate[]> {
  if (process.platform !== 'win32') {
    throw new Error('Network address selection requires Windows.')
  }
  const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const command = `chcp 437 >nul && "${join(systemDirectory, 'netsh.exe')}" interface ipv4 show address`
  const { stdout } = await execFileAsync(
    join(systemDirectory, 'cmd.exe'),
    ['/d', '/s', '/c', command],
    {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    },
  )
  const localAddresses = new Set(
    Object.values(networkInterfaces()).flatMap((items) =>
      (items ?? [])
        .filter((item) => item.family === 'IPv4' && !item.internal)
        .map((item) => item.address),
    ),
  )
  return rankNetworkAddresses(
    parseNetshAddresses(stdout).filter((item) => localAddresses.has(item.address)),
  )
}

/**
 * 创建推荐地址读取器，供服务快照调用；无候选或查询失败时 resolve 为 null。
 * 首次读取等待查询完成；结果缓存 30 秒，过期后读取仍返回缓存并在后台刷新。
 * 同时发起的读取共用一次查询，查询失败会记录错误并清空地址，下次到期重试。
 */
export function createRecommendedAddressReader(): () => Promise<string | null> {
  let address: string | null = null
  let hasLoaded = false
  let refreshAt = 0
  let pending: Promise<string | null> | null = null
  return () => {
    if (pending === null && Date.now() >= refreshAt) {
      pending = queryNetworkAddresses()
        .then((candidates) => {
          address = candidates[0]?.address ?? null
          return address
        })
        .catch((error: unknown) => {
          console.error('Failed to select the recommended IPv4 address.', error)
          address = null
          return null
        })
        .finally(() => {
          hasLoaded = true
          refreshAt = Date.now() + CACHE_MS
          pending = null
        })
    }
    return hasLoaded ? Promise.resolve(address) : (pending ?? Promise.resolve(address))
  }
}
