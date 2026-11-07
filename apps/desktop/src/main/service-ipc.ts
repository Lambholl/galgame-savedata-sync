import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { hostname } from 'node:os'
import { isOpaqueId } from '@savedata-sync/shared'
import type { DirectoryReference, OperationResult } from '@savedata-sync/shared'
import { SERVICE_CHANNELS } from '../bridge/service-bridge.ts'
import type { DesktopServiceSnapshot } from '../bridge/service-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { WindowsDiscoveryAdvertiser } from './discovery-advertiser.ts'
import type { WindowsHttpService } from './http-service.ts'
import type { WindowsNewFilePublisher } from './new-file-publisher.ts'
import { toHttpError } from './http-errors.ts'
import type { ServicePortSettings } from './service-port-settings.ts'
import { createNetworkAddressReader } from './recommended-address.ts'

/** 注册服务 IPC 的选项：存档目录选择器由主进程执行，null 表示取消，已有目录权限不变。 */
interface ServiceIpcOptions {
  readonly portSettings: ServicePortSettings
  /** 服务开始监听后在局域网广播，停止服务后停止广播；应用退出时由主进程入口另行停止。 */
  readonly advertiser: Pick<WindowsDiscoveryAdvertiser, 'start' | 'stop' | 'getState'>
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  readonly chooseTargetPath: () => Promise<string | null>
}

/** 与发给移动端的设备名同一取值；系统读不到时留空，不改用其他名称。 */
function localDeviceName(): string | null {
  try {
    return hostname() || null
  } catch {
    return null
  }
}

/** 注册服务控制 IPC，校验窗口、主 frame 和参数；写授权只来自本机系统选择器。退出时移除。 */
export function registerServiceIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  adapter: WindowsDirectoryAdapter,
  service: WindowsHttpService,
  publisher: WindowsNewFilePublisher,
  options: ServiceIpcOptions,
): () => void {
  const targets = new Map<string, DirectoryReference>()
  const readNetworkAddresses = createNetworkAddressReader()
  let isMutating = false
  async function snapshot(): Promise<OperationResult<DesktopServiceSnapshot>> {
    const networkAddresses = service.getAddress() ? await readNetworkAddresses() : []
    // 查询网卡时，服务可能已停止或换了端口。查完网卡重新查一遍服务和端口以保证界面信息最新。
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
              ipv4Addresses: networkAddresses,
              startedAt: address.startedAt,
            }
          : null,
        error: service.getError(),
        discovery: options.advertiser.getState(),
        targets: [...targets.values()],
        tasks: service.getStates(),
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
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      const fail = (code: 'permission-denied' | 'invalid-request' | 'busy', message: string) => ({
        status: 'error' as const,
        error: { code, message, canRetry: false },
      })
      if (!options.isTrustedSender(event)) {
        return fail('permission-denied', 'This page cannot control the local service.')
      }
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
          options.advertiser.start({
            port: listener.port,
            deviceId: adapter.deviceId,
            displayName: localDeviceName(),
          })
        } else if (action === 'revokeTarget' || action === 'cancel') {
          const id = argument(args, action === 'cancel' ? 'transferId' : 'rootId')
          if (!isOpaqueId(id)) {
            return fail('invalid-request', 'The reference is invalid.')
          }
          if (action === 'cancel') {
            service.cancel(id)
          } else {
            await publisher.revoke(id)
            targets.delete(id)
          }
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
            if (!options.isTrustedSender(event)) {
              return fail('permission-denied', 'The page has left the app.')
            }
            if (path === null) {
              return { status: 'cancelled' }
            }
            const result = await adapter.registerDirectory(path)
            if (result.status === 'error') {
              return result
            }
            await publisher.grant(result.value.rootId)
            targets.set(result.value.rootId, result.value)
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
          if (action === 'cleanup') {
            await service.retryCleanup()
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
