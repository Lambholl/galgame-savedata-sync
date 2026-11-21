import { Bonjour } from 'bonjour-service'
import type { Browser, Service } from 'bonjour-service'
import {
  DISCOVERY_SERVICE,
  isIpv4Address,
  isListeningPort,
  parseDiscoveryTxt,
} from '@savedata-sync/shared'
import { NEARBY_LEASE_MS } from '../bridge/dialer-bridge.ts'
import type { DesktopNearbyDevice, DesktopNearbyState } from '../bridge/dialer-bridge.ts'

/** 搜索期间多久重新发一次查询；mDNS 应答方只在被问到或上线时宣告。 */
const QUERY_INTERVAL_MS = 4_000

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
        addresses.length === 0
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
        for (const listener of [...this.listeners]) {
          listener()
        }
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
      }, QUERY_INTERVAL_MS)
      this.queryTimer.unref()
    } catch (error) {
      console.error('Failed to start LAN device search', error)
      this.close()
      this.status = 'failed'
    }
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
    this.status = 'off'
  }
}
