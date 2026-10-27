import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { networkInterfaces } from 'node:os'
import { isOpaqueId } from '@savedata-sync/shared'
import type { DirectoryReference, OperationResult } from '@savedata-sync/shared'
import { SERVICE_CHANNELS } from '../bridge/service-bridge.ts'
import type { DesktopServiceSnapshot } from '../bridge/service-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { WindowsHttpService } from './http-service.ts'
import type { WindowsNewFilePublisher } from './new-file-publisher.ts'
import { toHttpError } from './http-errors.ts'
import type { ServicePortSettings } from './service-port-settings.ts'

/** 存档目录选择器由主进程执行；null 表示取消，不撤销已有目录权限。 */
interface ServiceIpcOptions {
  readonly portSettings: ServicePortSettings
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  readonly chooseTargetPath: () => Promise<string | null>
}

/** 注册固定控制通道，校验窗口/主 frame/参数；授权只来自本机系统选择器。退出时移除。 */
export function registerServiceIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  adapter: WindowsDirectoryAdapter,
  service: WindowsHttpService,
  publisher: WindowsNewFilePublisher,
  options: ServiceIpcOptions,
): () => void {
  const targets = new Map<string, DirectoryReference>()
  let isMutating = false
  function snapshot(): OperationResult<DesktopServiceSnapshot> {
    const address = service.getAddress()
    const addresses = address
      ? [
          ...new Set(
            Object.values(networkInterfaces()).flatMap((items) =>
              (items ?? [])
                .filter((item) => item.family === 'IPv4' && !item.internal)
                .map((item) => `http://${item.address}:${address.port}`),
            ),
          ),
        ]
      : []
    return {
      status: 'success',
      value: {
        configuredPort: options.portSettings.getPort(),
        listener: address ? { host: address.host, port: address.port, addresses } : null,
        error: service.getError(),
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
        return fail('permission-denied', '此页面无法控制本地服务。')
      }
      if (action === 'status') {
        return args.length === 0 ? snapshot() : fail('invalid-request', '服务参数无效。')
      }
      if (isMutating) {
        return fail('busy', '正在处理上一项服务操作。')
      }
      isMutating = true
      try {
        if (action === 'start') {
          const port = argument(args, 'port')
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            return fail('invalid-request', '端口应为 1 到 65535 的整数。')
          }
          if (service.getAddress()) {
            return fail('busy', '请先停止服务再修改端口。')
          }
          await options.portSettings.save(port)
          await service.start({ host: '0.0.0.0', port })
        } else if (action === 'revokeTarget' || action === 'cancel') {
          const id = argument(args, action === 'cancel' ? 'transferId' : 'rootId')
          if (!isOpaqueId(id)) {
            return fail('invalid-request', '引用无效。')
          }
          if (action === 'cancel') {
            service.cancel(id)
          } else {
            await publisher.revoke(id)
            targets.delete(id)
          }
        } else {
          if (args.length !== 0) {
            return fail('invalid-request', '服务参数无效。')
          }
          if (action === 'randomizePort') {
            if (service.getAddress()) {
              return fail('busy', '请先停止服务再修改端口。')
            }
            await options.portSettings.randomize()
          }
          if (action === 'chooseTarget') {
            const path = await options.chooseTargetPath()
            if (!options.isTrustedSender(event)) {
              return fail('permission-denied', '页面已离开应用。')
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
            await service.stop()
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
