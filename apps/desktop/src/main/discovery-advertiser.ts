import { getResponder } from '@homebridge/ciao'
import type { Responder } from '@homebridge/ciao'
import {
  DISCOVERY_SERVICE,
  createDiscoveryInstanceName,
  createDiscoveryTxt,
} from '@savedata-sync/shared'
import type { OperationError } from '@savedata-sync/shared'
import type { DesktopDiscoveryState } from '../bridge/service-bridge.ts'

/** 注册失败后，服务仍在运行时隔多久重新注册。 */
const RETRY_DELAY_MS = 30_000
/** 停止广播时最多等多久发完 goodbye 包；超时后不再等待，停止服务和退出应用不会被拖住。 */
const RELEASE_TIMEOUT_MS = 3_000
/** DNS 主机名的一个标签最多 63 个字节。 */
const MAX_HOST_LABEL_LENGTH = 63

const ADVERTISE_FAILURE: OperationError = {
  code: 'network-failure',
  message: 'Cannot advertise the local service on the LAN. It will retry automatically.',
  canRetry: false,
}

/** 要广播的 HTTP 服务：实际监听端口、本机设备 ID 和设备显示名。 */
export interface DiscoveryAdvertisement {
  readonly port: number
  readonly deviceId: string
  /** 设备显示名，用作 DNS-SD 实例名；为 null 或截断后为空时改用服务名 savedata-sync。 */
  readonly displayName: string | null
}

const OFF_STATE: DesktopDiscoveryState = { status: 'off', instanceName: null, error: null }

// ciao 默认用实例名当主机名，而实例名是设备显示名，可能含中文或空格。
// 设备 ID 只含字母、数字、`_` 和 `-`，把 `_` 换成 `-` 后是合法的 DNS 主机名标签，各设备之间也不会重名。
/** 由设备 ID 生成 SRV 记录指向的主机名标签。 */
function createHostLabel(deviceId: string): string {
  return `${DISCOVERY_SERVICE.name}-${deviceId}`
    .toLowerCase()
    .replace(/_/g, '-')
    .slice(0, MAX_HOST_LABEL_LENGTH)
    .replace(/-+$/, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * 在局域网用 mDNS 广播本机 HTTP 服务，DNS-SD 服务类型是 `_savedata-sync._tcp`。
 * 注册失败时状态变为 failed 并定时重试；停止后释放 UDP 5353。
 */
export class WindowsDiscoveryAdvertiser {
  private responder: Responder | null = null
  private advertisement: DiscoveryAdvertisement | null = null
  private state: DesktopDiscoveryState = OFF_STATE
  private retryTimer: NodeJS.Timeout | null = null
  /** 每次 start 或 stop 加一；异步注册完成时代数已变，说明期间被停止或重新启动，结果作废。 */
  private generation = 0
  /** 上一个 Responder 的关闭过程；新的注册等它结束后再开始。 */
  private releasing: Promise<void> = Promise.resolve()

  /** 返回当前广播状态的副本。 */
  getState(): DesktopDiscoveryState {
    return { ...this.state }
  }

  /**
   * 开始广播给定的服务，立即返回；注册结果通过 getState 读取。
   * 正在广播时先关闭当前广播，再按新的端口和名称注册。
   */
  start(advertisement: DiscoveryAdvertisement): void {
    this.advertisement = advertisement
    this.generation += 1
    this.clearRetry()
    this.release()
    this.state = { status: 'starting', instanceName: null, error: null }
    this.launch(this.generation)
  }

  /**
   * 停止广播：取消重试，发送 goodbye 包并关闭 Responder。
   * 关闭失败只记录日志；Promise 总是 resolve，最多等待 RELEASE_TIMEOUT_MS。
   */
  async stop(): Promise<void> {
    this.advertisement = null
    this.generation += 1
    this.clearRetry()
    this.state = OFF_STATE
    this.release()
    await this.releasing
  }

  /** 等上一个 Responder 关闭后注册一次服务；失败时关闭 Responder 并安排重试。期间被停止或重新启动时放弃本次结果。 */
  private async advertise(generation: number): Promise<void> {
    await this.releasing
    const advertisement = this.advertisement
    if (generation !== this.generation || !advertisement) {
      return
    }
    let instanceName =
      createDiscoveryInstanceName(advertisement.displayName ?? '') || DISCOVERY_SERVICE.name
    try {
      // 拨号方只用 IPv4，不绑定 IPv6 套接字，也不发 AAAA 记录。
      const responder = getResponder({ disableIpv6: true })
      this.responder = responder
      const service = responder.createService({
        name: instanceName,
        type: DISCOVERY_SERVICE.name,
        hostname: createHostLabel(advertisement.deviceId),
        port: advertisement.port,
        txt: createDiscoveryTxt({ deviceId: advertisement.deviceId, platform: 'windows' }),
        disabledIpv6: true,
      })
      service.on('name-change', (name: string) => {
        instanceName = name
        if (generation === this.generation && this.state.status === 'advertising') {
          this.state = { ...this.state, instanceName: name }
        }
      })
      await service.advertise()
    } catch (error) {
      if (generation !== this.generation) {
        return
      }
      console.error('Failed to advertise the local service', { message: errorMessage(error) })
      this.state = { status: 'failed', instanceName: null, error: { ...ADVERTISE_FAILURE } }
      this.release()
      await this.releasing
      if (generation === this.generation) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          // 重试期间状态保持 failed，界面不会每 30 秒在失败和注册中之间闪动。
          this.launch(generation)
        }, RETRY_DELAY_MS)
        this.retryTimer.unref()
      }
      return
    }
    if (generation === this.generation) {
      this.state = { status: 'advertising', instanceName, error: null }
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /**
   * 关闭当前 Responder：已宣告的服务发送 goodbye 包，正在探测的服务取消，随后关闭套接字。
   * 关闭排在上一次关闭之后执行，进度记在 releasing。
   */
  private release(): void {
    const responder = this.responder
    this.responder = null
    if (responder) {
      this.releasing = this.releasing.then(() =>
        Promise.race([responder.shutdown(), delay(RELEASE_TIMEOUT_MS)]).catch((error: unknown) => {
          console.error('Failed to stop advertising the local service', {
            message: errorMessage(error),
          })
        }),
      )
    }
  }

  /** 在后台注册一次服务；advertise 已处理注册失败，这里只记录意外异常。 */
  private launch(generation: number): void {
    this.advertise(generation).catch((error: unknown) => {
      console.error('Failed to advertise the local service', { message: errorMessage(error) })
    })
  }
}
