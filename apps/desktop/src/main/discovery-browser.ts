import { get as httpGet } from 'node:http'
import { Bonjour } from 'bonjour-service'
import type { Browser, Service } from 'bonjour-service'
import {
  DISCOVERY_SERVICE,
  HTTP_ROUTES,
  isIpv4Address,
  isListeningPort,
  parseDiscoveryTxt,
} from '@savedata-sync/shared'
import { NEARBY_LEASE_MS } from '../bridge/dialer-bridge.ts'
import type { DesktopNearbyDevice, DesktopNearbyState } from '../bridge/dialer-bridge.ts'

/** 搜索期间多久重新发一次查询并重新探测；mDNS 应答方只在被问到或上线时宣告。 */
const QUERY_INTERVAL_MS = 4_000

/** 探测请求从连接到收到状态行的最长等待。 */
const PROBE_TIMEOUT_MS = 2_000

/** 已出现在结果里的服务连续探测失败这么多次才去掉，Wi-Fi 偶尔丢包时不闪烁。还没出现过的服务第一次探测成功才加入。 */
const MAX_PROBE_FAILURES = 2

/** 一个服务的探测状态。 */
interface Liveness {
  /** 最近的探测确认它在线；只有在线的服务出现在结果里。 */
  isAlive: boolean
  isProbing: boolean
  /** 上次探测成功以来连续失败的次数。 */
  failures: number
}

/** 探测状态的键：同一实例名换了端口或地址时按新服务重新探测。 */
function livenessKey(service: Service, addresses: readonly string[]): string {
  return `${service.name}|${service.port}|${addresses.join(',')}`
}

/** 请求 address:port 的 /v1/device，回 200 时为 true；连不上、超时或其他状态时为 false。 */
function isListening(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        host: address,
        port,
        path: HTTP_ROUTES.device,
        agent: false,
        timeout: PROBE_TIMEOUT_MS,
        headers: { connection: 'close' },
      },
      (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

/** 依次探测各地址，任一地址在线时为 true。 */
async function isAnyListening(addresses: readonly string[], port: number): Promise<boolean> {
  for (const address of addresses) {
    if (await isListening(address, port)) {
      return true
    }
  }
  return false
}

/** 把 TXT 的值统一成字符串；bonjour-service 可能给出 Buffer。 */
function txtRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item
    } else if (Buffer.isBuffer(item)) {
      result[key] = item.toString('utf8')
    }
  }
  return result
}

/** 一个服务的 IPv4 地址：先取 A 记录，没有时用应答包的来源地址。 */
function serviceAddresses(service: Service): readonly string[] {
  const addresses = (service.addresses ?? []).filter(isIpv4Address)
  const referer = service.referer?.address
  return [
    ...new Set(addresses.length ? addresses : referer && isIpv4Address(referer) ? [referer] : []),
  ]
}

/**
 * 在局域网搜索监听方（DNS-SD `_savedata-sync._tcp`）。续期后搜索，停止续期超过 NEARBY_LEASE_MS 后停止并释放 UDP 5353；
 * 按设备 ID 查找期间也保持搜索。
 *
 * 搜到的服务要请求 `/v1/device` 得到 200 才出现在结果里，搜索期间每 QUERY_INTERVAL_MS 重新探测一次；
 * 已出现的服务连续 MAX_PROBE_FAILURES 次探测失败后从结果里去掉。
 */
export class WindowsDiscoveryBrowser {
  private bonjour: Bonjour | null = null
  private browser: Browser | null = null
  private queryTimer: NodeJS.Timeout | null = null
  private leaseUntil = 0
  private lookups = 0
  private stopTimer: NodeJS.Timeout | null = null
  private status: DesktopNearbyState['status'] = 'off'
  private readonly listeners = new Set<() => void>()
  private readonly liveness = new Map<string, Liveness>()
  /** 每轮搜索加一；关闭后才到的探测结果按轮次丢弃。 */
  private generation = 0

  /** @param localDeviceId 本机设备 ID，搜索结果里排除它。 */
  constructor(private readonly localDeviceId: string) {}

  /** 续期并返回当前结果；没在搜索时开始搜索。 */
  watch(): DesktopNearbyState {
    this.leaseUntil = Date.now() + NEARBY_LEASE_MS
    this.ensure()
    this.scheduleStop()
    return this.state()
  }

  /** 当前搜索状态和结果，不续期。 */
  state(): DesktopNearbyState {
    const devices = new Map<string, DesktopNearbyDevice>()
    const incompatibleNames: string[] = []
    for (const service of this.browser?.services ?? []) {
      const port = service.port
      const addresses = serviceAddresses(service)
      const txt = parseDiscoveryTxt(txtRecord(service.txt))
      if (txt.status === 'unsupported-version') {
        incompatibleNames.push(service.name)
        continue
      }
      if (
        txt.status !== 'valid' ||
        txt.identity.deviceId === this.localDeviceId ||
        !isListeningPort(port) ||
        addresses.length === 0 ||
        !this.liveness.get(livenessKey(service, addresses))?.isAlive
      ) {
        continue
      }
      const known = devices.get(txt.identity.deviceId)
      // 同一设备可能出现在多个实例名下：改名后旧记录还没过期。端口不同时分不出哪条是现在的，保留先收到的。
      if (!known) {
        devices.set(txt.identity.deviceId, {
          deviceId: txt.identity.deviceId,
          platform: txt.identity.platform,
          name: service.name,
          port,
          addresses,
        })
      } else if (known.port === port) {
        devices.set(known.deviceId, {
          ...known,
          addresses: [...new Set([...known.addresses, ...addresses])],
        })
      }
    }
    return {
      status: this.status,
      devices: [...devices.values()],
      incompatibleNames: [...new Set(incompatibleNames)],
    }
  }

  /** 按设备 ID 查找，最多等 timeoutMs；查到就返回，超时、取消或搜索失败时返回 null。查找期间保持搜索。 */
  find(
    deviceId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<DesktopNearbyDevice | null> {
    return new Promise((resolve) => {
      let isDone = false
      const check = (): void => {
        const device = this.state().devices.find((item) => item.deviceId === deviceId)
        if (device) {
          finish(device)
        } else if (this.status === 'failed') {
          finish(null)
        }
      }
      const finish = (device: DesktopNearbyDevice | null): void => {
        if (isDone) {
          return
        }
        isDone = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.listeners.delete(check)
        this.lookups--
        this.scheduleStop()
        resolve(device)
      }
      const abort = (): void => finish(null)
      const timer = setTimeout(abort, timeoutMs)
      this.lookups++
      this.listeners.add(check)
      signal.addEventListener('abort', abort)
      if (signal.aborted) {
        abort()
        return
      }
      this.ensure()
      check()
    })
  }

  /** 停止搜索，释放端口。 */
  stop(): void {
    this.leaseUntil = 0
    this.close()
  }

  private ensure(): void {
    if (this.browser) {
      return
    }
    try {
      // 第二个参数是套接字错误回调；不传时 multicast-dns 的错误会成为未处理异常让主进程退出。
      const bonjour = new Bonjour({}, () => undefined)
      const browser = bonjour.find({ type: DISCOVERY_SERVICE.name, protocol: 'tcp' })
      const changed = (): void => {
        this.probeAll()
        this.notify()
      }
      browser.on('up', changed)
      browser.on('down', changed)
      browser.on('txt-update', changed)
      browser.on('srv-update', changed)
      this.bonjour = bonjour
      this.browser = browser
      this.status = 'searching'
      this.queryTimer = setInterval(() => {
        try {
          browser.expire()
          browser.update()
        } catch {
          /* 发送查询失败时下一轮再试；已有结果按 TTL 过期。 */
        }
        this.probeAll()
      }, QUERY_INTERVAL_MS)
      this.queryTimer.unref()
    } catch (error) {
      console.error('Failed to start LAN device search', error)
      this.close()
      this.status = 'failed'
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener()
    }
  }

  /** 探测当前全部服务，并丢掉已经不在搜索结果里的探测状态。 */
  private probeAll(): void {
    const keys = new Set<string>()
    for (const service of this.browser?.services ?? []) {
      const addresses = serviceAddresses(service)
      const txt = parseDiscoveryTxt(txtRecord(service.txt))
      if (
        txt.status !== 'valid' ||
        txt.identity.deviceId === this.localDeviceId ||
        !isListeningPort(service.port) ||
        addresses.length === 0
      ) {
        continue
      }
      const key = livenessKey(service, addresses)
      keys.add(key)
      this.probe(key, addresses, service.port)
    }
    for (const key of this.liveness.keys()) {
      if (!keys.has(key)) {
        this.liveness.delete(key)
      }
    }
  }

  /** 探测一个服务；同一服务上一次探测还没结束时跳过。在线状态变化时通知查找中的调用方。 */
  private probe(key: string, addresses: readonly string[], port: number): void {
    const known = this.liveness.get(key) ?? { isAlive: false, isProbing: false, failures: 0 }
    this.liveness.set(key, known)
    if (known.isProbing) {
      return
    }
    known.isProbing = true
    const generation = this.generation
    isAnyListening(addresses, port)
      .then((isReachable) => {
        known.isProbing = false
        if (generation !== this.generation || this.liveness.get(key) !== known) {
          return
        }
        const wasAlive = known.isAlive
        if (isReachable) {
          known.failures = 0
          known.isAlive = true
        } else {
          known.failures++
          if (!wasAlive || known.failures >= MAX_PROBE_FAILURES) {
            known.isAlive = false
          }
        }
        if (known.isAlive !== wasAlive) {
          this.notify()
        }
      })
      .catch((error: unknown) => console.error('LAN device probe failed', error))
  }

  private scheduleStop(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (this.lookups > 0) {
      return
    }
    const remaining = this.leaseUntil - Date.now()
    if (remaining <= 0) {
      this.close()
      return
    }
    this.stopTimer = setTimeout(() => this.scheduleStop(), remaining)
    this.stopTimer.unref()
  }

  private close(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (this.queryTimer) {
      clearInterval(this.queryTimer)
      this.queryTimer = null
    }
    try {
      this.browser?.stop()
      this.bonjour?.destroy()
    } catch {
      /* 关闭时的套接字错误不影响下次搜索。 */
    }
    this.browser = null
    this.bonjour = null
    this.liveness.clear()
    this.generation++
    this.status = 'off'
  }
}
