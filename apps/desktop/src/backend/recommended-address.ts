import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MAX_CANDIDATE_ADDRESSES } from '@savedata-sync/shared'

const execFileAsync = promisify(execFile)
const CACHE_MS = 30_000
const QUERY_TIMEOUT_MS = 10_000
/** 路由表里查不到 metric 的地址排在查得到的后面。 */
const UNKNOWN_METRIC = 1_000_000
/** 网卡设备类的注册表键，每块网卡一个子键，记录 NetCfgInstanceId（网卡 GUID）和 Characteristics。 */
const ADAPTER_CLASS_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}'
/** 每块网卡的 TCP/IP 设置，子键名是网卡 GUID，记录手动配置的 IPAddress 和 DHCP 分到的 DhcpIPAddress。 */
const TCPIP_INTERFACES_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
/** Characteristics 的 NCF_VIRTUAL 和 NCF_PHYSICAL 位，由网卡驱动安装信息写入。 */
const NCF_VIRTUAL = 0x1
const NCF_PHYSICAL = 0x4

/** 本机一个 IPv4 地址及其所在网卡的信息，用来判断其他设备能不能访问到它。 */
export interface NetworkAddressCandidate {
  readonly address: string
  readonly interfaceName: string
  /**
   * 网卡驱动声明自己是物理网卡（NCF_PHYSICAL 且不是 NCF_VIRTUAL），如 PCI 有线网卡、无线网卡和 USB 网卡；
   * 虚拟机、Hyper-V、VPN、代理和热点网卡都不是。注册表里找不到这个地址时按非物理网卡处理。
   */
  readonly isPhysical: boolean
  /** 地址所在网卡上有 IPv4 默认路由。 */
  readonly hasDefaultRoute: boolean
  /** 有默认路由时取默认路由的 metric，否则取本机地址主机路由的 metric。越小越优先。 */
  readonly metric: number
}

/** `route print -4` 中按本机地址整理出的路由 metric。 */
export interface LocalRouteMetrics {
  /** 本机地址 → 经它出去的默认路由（0.0.0.0/0）中最小的 metric。 */
  readonly defaultRoutes: ReadonlyMap<string, number>
  /** 本机地址 → 指向它自己的主机路由（/32）的 metric，等于接口 metric 加 256。 */
  readonly hostRoutes: ReadonlyMap<string, number>
}

/** Windows 移动热点和 Internet 连接共享固定使用的本机地址；这块网卡是虚拟的、没有默认路由，但连上热点的设备能访问。 */
const WINDOWS_HOTSPOT_ADDRESS = '192.168.137.1'

function setMinimum(map: Map<string, number>, key: string, value: number): void {
  map.set(key, Math.min(value, map.get(key) ?? value))
}

/**
 * 解析 `route print -4` 的活动路由表。只读每行开头的目标、掩码和末尾的接口地址、metric：
 * 表头和网关列（“On-link”）会随系统语言变化，但这几列始终是数字。
 * 永久路由表每行只有四列、没有接口地址，按列数排除。
 */
export function parseRoutePrint(output: string): LocalRouteMetrics {
  const defaultRoutes = new Map<string, number>()
  const hostRoutes = new Map<string, number>()
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    const [destination = '', mask = ''] = columns
    const local = columns.at(-2) ?? ''
    const metric = Number(columns.at(-1))
    if (columns.length < 5 || !isIPv4(local) || !Number.isSafeInteger(metric) || metric < 0) {
      continue
    }
    if (destination === '0.0.0.0' && mask === '0.0.0.0') {
      setMinimum(defaultRoutes, local, metric)
    } else if (destination === local && mask === '255.255.255.255') {
      setMinimum(hostRoutes, local, metric)
    }
  }
  return { defaultRoutes, hostRoutes }
}

/** `reg query` 输出中的一个值；data 是 reg 打印的原文，REG_MULTI_SZ 各项以 `\0` 分隔。 */
interface RegistryValue {
  readonly key: string
  readonly name: string
  readonly data: string
}

function parseRegistryQuery(output: string): RegistryValue[] {
  const values: RegistryValue[] = []
  let key = ''
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      key = line.trim()
      continue
    }
    const match = /^\s+(\S+)\s+REG_[A-Z0-9_]+\s*(.*)$/.exec(line)
    if (match && key) {
      values.push({ key, name: match[1] ?? '', data: (match[2] ?? '').trim() })
    }
  }
  return values
}

/**
 * 从网卡设备类和 TCP/IP 设置的注册表查询结果中找出物理网卡上的 IPv4 地址。
 * 停用或断开的网卡也可能留着上次的地址，结果不代表地址当前可用。
 *
 * @param classOutput ADAPTER_CLASS_KEY 下 NetCfgInstanceId 和 Characteristics 两次查询的输出拼在一起。
 * @param tcpipOutput TCPIP_INTERFACES_KEY 下按名称搜索 IPAddress 的输出。
 */
export function parsePhysicalAddresses(classOutput: string, tcpipOutput: string): Set<string> {
  const adapters = new Map<string, { id?: string; characteristics?: number }>()
  for (const value of parseRegistryQuery(classOutput)) {
    const adapter = adapters.get(value.key) ?? {}
    if (value.name === 'NetCfgInstanceId') {
      adapter.id = value.data.toLowerCase()
    } else if (value.name === 'Characteristics') {
      adapter.characteristics = Number(value.data)
    }
    adapters.set(value.key, adapter)
  }
  const physicalIds = new Set(
    [...adapters.values()]
      .filter(
        ({ id, characteristics = 0 }) =>
          id && (characteristics & NCF_PHYSICAL) !== 0 && (characteristics & NCF_VIRTUAL) === 0,
      )
      .map(({ id }) => id),
  )
  const addresses = new Set<string>()
  for (const value of parseRegistryQuery(tcpipOutput)) {
    const id = /\\Interfaces\\(\{[0-9a-f-]+\})$/i.exec(value.key)?.[1]?.toLowerCase()
    if (id && physicalIds.has(id) && /^(Dhcp)?IPAddress$/.test(value.name)) {
      for (const address of value.data.split('\\0')) {
        if (isIPv4(address)) {
          addresses.add(address)
        }
      }
    }
  }
  return addresses
}

function isUsableAddress(address: string): boolean {
  const [first = 0, second = 0] = address.split('.').map(Number)
  return (
    isIPv4(address) &&
    first > 0 &&
    first < 224 &&
    first !== 127 &&
    !address.startsWith('169.254.') &&
    // 198.18.0.0/15 是测试保留段，代理软件的虚拟网卡（TUN）常用它，其他设备访问不到。
    !(first === 198 && (second === 18 || second === 19))
  )
}

function byMetric(a: NetworkAddressCandidate, b: NetworkAddressCandidate): number {
  return (
    a.metric - b.metric ||
    a.interfaceName.localeCompare(b.interfaceName) ||
    a.address.localeCompare(b.address, 'en', { numeric: true })
  )
}

// 虚拟机、Hyper-V、Docker、VPN 和代理的虚拟网卡上的地址其他设备访问不到，列出来既暴露本机的内部网络，
// 又会让扫码的设备去连它所在网络里碰巧用同一地址的其他主机，所以优先选物理网卡。
// Hyper-V 外部交换机会把本机地址移到虚拟网卡上，所以物理网卡没有地址时退到任意有默认路由的网卡。
// 两台设备用网线直连、手动配置地址时没有默认路由，最后退回全部可用地址，免得没有地址可试。
/**
 * 选出其他设备可能访问到的地址并排序，返回新数组；没有合适地址时返回空数组。
 * 按下面的顺序取第一组非空的局域网地址：
 * 1. 物理网卡且有默认路由。
 * 2. 任意有默认路由的网卡。
 * 局域网地址之后再加上 Windows 移动热点地址。两组都没有地址时：有热点只给热点，否则返回全部可用地址。
 * 组内先比较 metric，再用接口名称和地址稳定排序。
 */
export function rankNetworkAddresses(
  candidates: readonly NetworkAddressCandidate[],
): NetworkAddressCandidate[] {
  const usable = candidates.filter((candidate) => isUsableAddress(candidate.address))
  const hotspots = usable.filter((candidate) => candidate.address === WINDOWS_HOTSPOT_ADDRESS)
  const others = usable.filter((candidate) => candidate.address !== WINDOWS_HOTSPOT_ADDRESS)
  const lan = [
    others.filter((candidate) => candidate.isPhysical && candidate.hasDefaultRoute),
    others.filter((candidate) => candidate.hasDefaultRoute),
  ].find((group) => group.length > 0)
  if (lan) {
    return [...lan.sort(byMetric), ...hotspots]
  }
  return hotspots.length ? hotspots : usable.sort(byMetric)
}

async function runSystemTool(file: string, args: readonly string[]): Promise<string> {
  const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  // 输出按系统代码页编码；这里只解析其中的 ASCII 部分（地址、数字、GUID），按 latin1 读入不会改变它们。
  const { stdout } = await execFileAsync(join(systemDirectory, file), args, {
    encoding: 'latin1',
    windowsHide: true,
    timeout: QUERY_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

/** 运行 reg 查询；失败时（如键不存在、没有匹配项）返回空字符串。 */
async function readRegistry(args: readonly string[]): Promise<string> {
  try {
    return await runSystemTool('reg.exe', ['query', ...args])
  } catch (error) {
    console.warn('Failed to read the network adapter registry.', error)
    return ''
  }
}

/**
 * 读取本机非回环 IPv4 地址，查询路由表和注册表，返回按 rankNetworkAddresses 选出并排序的地址。
 * 系统命令在隐藏窗口里运行，每个最长等 10 秒。
 * 路由表读取失败或不是 Windows 时 reject；注册表读取失败时按没有物理网卡处理。
 */
export async function queryNetworkAddresses(): Promise<NetworkAddressCandidate[]> {
  if (process.platform !== 'win32') {
    throw new Error('Network address selection requires Windows.')
  }
  const [routes, classIds, classCharacteristics, tcpip] = await Promise.all([
    runSystemTool('route.exe', ['print', '-4']),
    readRegistry([ADAPTER_CLASS_KEY, '/s', '/v', 'NetCfgInstanceId']),
    readRegistry([ADAPTER_CLASS_KEY, '/s', '/v', 'Characteristics']),
    readRegistry([TCPIP_INTERFACES_KEY, '/s', '/f', 'IPAddress']),
  ])
  const { defaultRoutes, hostRoutes } = parseRoutePrint(routes)
  const physical = parsePhysicalAddresses(`${classIds}\n${classCharacteristics}`, tcpip)
  return rankNetworkAddresses(
    Object.entries(networkInterfaces()).flatMap(([interfaceName, items]) =>
      (items ?? [])
        .filter((item) => item.family === 'IPv4' && !item.internal)
        .map(({ address }) => {
          const defaultMetric = defaultRoutes.get(address)
          return {
            address,
            interfaceName,
            isPhysical: physical.has(address),
            hasDefaultRoute: defaultMetric !== undefined,
            metric: defaultMetric ?? hostRoutes.get(address) ?? UNKNOWN_METRIC,
          }
        }),
    ),
  )
}

/** 带缓存的本机 IPv4 地址读取器。 */
export interface NetworkAddressReader {
  /**
   * 立即返回缓存的地址，按推荐顺序排列，第一个是推荐地址，最多 MAX_CANDIDATE_ADDRESSES 个；
   * 还没读到时返回 null，无候选或查询失败时为空数组。缓存不存在或超过 30 秒时在后台查询，
   * 查询期间仍返回缓存；同一时间只有一次查询。
   */
  read(): readonly string[] | null
  /** 丢弃缓存，之后的 read 在新的查询完成前返回 null。进行中的查询结果作废。 */
  reset(): void
}

/** 创建本机 IPv4 地址读取器；query 默认为 queryNetworkAddresses。查询失败时记录错误并缓存空数组，30 秒后重试。 */
export function createNetworkAddressReader(
  query: () => Promise<readonly NetworkAddressCandidate[]> = queryNetworkAddresses,
): NetworkAddressReader {
  let addresses: readonly string[] | null = null
  let refreshAt = 0
  let generation = 0
  let isQuerying = false
  async function refresh(): Promise<void> {
    const current = generation
    let result: readonly string[] = []
    try {
      // 同一地址可能出现在两块网卡上（如桥接），只保留排序靠前的一次。
      result = [...new Set((await query()).map((item) => item.address))].slice(
        0,
        MAX_CANDIDATE_ADDRESSES,
      )
    } catch (error) {
      console.error('Failed to read the local IPv4 addresses.', error)
    } finally {
      isQuerying = false
    }
    if (current === generation) {
      addresses = result
      refreshAt = Date.now() + CACHE_MS
    }
  }
  return {
    read() {
      if (!isQuerying && Date.now() >= refreshAt) {
        isQuerying = true
        // refresh 自己捕获查询错误，这里只防止意外异常变成未处理的 Promise。
        refresh().catch((error: unknown) => console.error(error))
      }
      return addresses
    },
    reset() {
      generation++
      addresses = null
      refreshAt = 0
    },
  }
}
