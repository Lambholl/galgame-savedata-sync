import { hostname } from 'node:os'
import { isOpaqueId } from '@savedata-sync/shared'
import type { OperationResult } from '@savedata-sync/shared'
import { SERVICE_CHANNELS } from '../bridge/service-bridge.ts'
import type { DesktopServiceSnapshot } from '../bridge/service-bridge.ts'
import type { DesktopDirectoryAdapter } from './directory-adapter.ts'
import type { DesktopDiscoveryAdvertiser } from './discovery-advertiser.ts'
import type { DesktopHttpService } from './http-service.ts'
import { toHttpError } from './http-errors.ts'
import type { ServicePortSettings } from './service-port-settings.ts'
import { createNetworkAddressReader } from './recommended-address.ts'
import type { ChannelRegistry } from './channel-registry.ts'

/** 注册服务通道的选项。 */
interface ServiceIpcOptions {
  readonly portSettings: ServicePortSettings
  /** 服务开始监听后在局域网广播，停止服务后停止广播。 */
  readonly advertiser: Pick<DesktopDiscoveryAdvertiser, 'start' | 'stop' | 'getState'>
  /** 打开系统目录选择器，返回选中的绝对路径；取消时返回 null。 */
  readonly chooseTargetPath: () => Promise<string | null>
}

/** 本机设备名，与发给移动端的名称相同；系统读不到时返回 null。 */
function localDeviceName(): string | null {
  try {
    return hostname() || null
  } catch {
    return null
  }
}

/**
 * 注册服务接口的通道处理函数；参数无效时返回错误结果。
 *
 * @returns 移除这些处理函数的函数。
 */
export function registerServiceIpc(
  ipc: ChannelRegistry,
  adapter: DesktopDirectoryAdapter,
  service: DesktopHttpService,
  options: ServiceIpcOptions,
): () => void {
  const networkAddresses = createNetworkAddressReader()
  let isMutating = false
  // 快照不等待网卡查询：服务运行时带上缓存的地址，还没读到时为 null，状态读取保持即时。
  function snapshot(): OperationResult<DesktopServiceSnapshot> {
    const address = service.getAddress()
    return {
      status: 'success',
      value: {
        deviceId: adapter.deviceId,
        deviceName: localDeviceName(),
        configuredPort: options.portSettings.getPort(),
        listener: address
          ? {
              host: address.host,
              port: address.port,
              ipv4Addresses: networkAddresses.read(),
              startedAt: address.startedAt,
            }
          : null,
        error: service.getError(),
        discovery: options.advertiser.getState(),
      },
    }
  }
  function argument(args: unknown[], key: string): unknown {
    const value = args[0]
    return args.length === 1 &&
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key]
      : undefined
  }
  for (const [action, channel] of Object.entries(SERVICE_CHANNELS)) {
    ipc.handle(channel, async (...args: unknown[]) => {
      const fail = (code: 'invalid-request' | 'busy', message: string) => ({
        status: 'error' as const,
        error: { code, message, canRetry: false },
      })
      if (action === 'status') {
        return args.length === 0
          ? snapshot()
          : fail('invalid-request', 'Service parameters are invalid.')
      }
      if (action === 'scanQuery') {
        const id = argument(args, 'scanId')
        if (!isOpaqueId(id)) {
          return fail('invalid-request', 'The scan reference is invalid.')
        }
        try {
          return { status: 'success', value: service.getScan(id) }
        } catch (error) {
          return { status: 'error', error: toHttpError(error).operationError }
        }
      }
      if (isMutating) {
        return fail('busy', 'The previous service operation is still being processed.')
      }
      isMutating = true
      try {
        if (action === 'scanStart' || action === 'scanCancel') {
          const id = argument(args, action === 'scanStart' ? 'rootId' : 'scanId')
          if (!isOpaqueId(id)) {
            return fail('invalid-request', 'The scan reference is invalid.')
          }
          return {
            status: 'success',
            value: action === 'scanStart' ? service.startScan(id) : service.cancelScan(id),
          }
        } else if (action === 'start') {
          const port = argument(args, 'port')
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            return fail('invalid-request', 'The port must be an integer from 1 to 65535.')
          }
          if (service.getAddress()) {
            return fail('busy', 'Stop the service before changing the port.')
          }
          await options.portSettings.save(port)
          const listener = await service.start({ host: '0.0.0.0', port })
          // 服务停止期间网络可能变了（换了 Wi-Fi、开了 VPN），每次启动都重新读取地址。
          networkAddresses.reset()
          options.advertiser.start({
            port: listener.port,
            deviceId: adapter.deviceId,
            displayName: localDeviceName(),
          })
        } else {
          if (args.length !== 0) {
            return fail('invalid-request', 'Service parameters are invalid.')
          }
          if (action === 'randomizePort') {
            if (service.getAddress()) {
              return fail('busy', 'Stop the service before changing the port.')
            }
            await options.portSettings.randomize()
          }
          if (action === 'chooseTarget') {
            const path = await options.chooseTargetPath()
            if (path === null) {
              return { status: 'cancelled' }
            }
            const result = await adapter.registerDirectory(path)
            if (result.status === 'error') {
              return result
            }
            return { status: 'selected', directory: result.value }
          }
          if (action === 'stop') {
            // stop 失败时监听也已关闭，所以无论成败都停止广播，免得其他设备搜到连不上的地址。
            try {
              await service.stop()
            } finally {
              await options.advertiser.stop()
            }
          }
        }
        return snapshot()
      } catch (error) {
        return { status: 'error', error: toHttpError(error).operationError }
      } finally {
        isMutating = false
      }
    })
  }
  return () => {
    for (const channel of Object.values(SERVICE_CHANNELS)) {
      ipc.removeHandler(channel)
    }
  }
}
