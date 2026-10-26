import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import {
  BATCH_LIMITS,
  BATCH_RESOURCES,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  PROTOCOL_VERSION,
} from '@savedata-sync/shared'
import type { DeviceDescriptor, OperationError, OperationResult } from '@savedata-sync/shared'
import type { WindowsArchiveAdapter } from './archive-adapter.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { inspectHttpRequest, readHttpJson, sendHttpFailure, sendHttpJson } from './http-wire.ts'
import { WindowsTransferRegistry } from './transfer-registry.ts'
import type { TransferRegistryOptions } from './transfer-registry.ts'

type HttpDirectorySource = Pick<WindowsDirectoryAdapter, 'deviceId' | 'listRoots' | 'listDirectory'>
type HttpArchiveProvider = Pick<WindowsArchiveAdapter, 'prepare' | 'retryCleanup'>

/** 仅受信任主进程可指定监听；缺省回环/动态端口，不在构造时启动网络。 */
export interface HttpListenOptions {
  readonly host?: string
  readonly port?: number
}

/** 原生监听快照不包含目录路径；sessionId 每次实际启动重新生成，不是认证凭据。 */
export interface HttpListenerAddress {
  readonly host: string
  readonly port: number
  readonly sessionId: string
}

/** 本机缩紧预算/时钟注入见任务注册表，不会经 HTTP 或 Renderer 暴露。 */
export interface WindowsHttpOptions extends TransferRegistryOptions {
  readonly displayName?: string
}

/**
 * v1 只读 HTTP 服务；复用已登记根和私有归档，没有上传、目标发布或自动重放。
 * start/stop 为受信任原生控制，UI 接入留后续包；start 失败抛脱敏 HttpOperationError。
 * stop 关闭所有连接、取消并等待任务及缓存清理；失败可再次 stop 重试，不提前丢弃所有权。
 * 主进程退出必须 await stop；调用示例和 LAN/回环边界见桌面 README。
 */
export class WindowsHttpService {
  private readonly source: HttpDirectorySource
  private readonly archive: HttpArchiveProvider
  private readonly options: WindowsHttpOptions
  private readonly sockets = new Set<Socket>()
  private server: Server | null = null
  private registry: WindowsTransferRegistry | null = null
  private address: HttpListenerAddress | null = null
  private stopping: Promise<void> | null = null
  private starting: Promise<HttpListenerAddress> | null = null
  private runtimeError: OperationError | null = null

  constructor(
    source: HttpDirectorySource,
    archive: HttpArchiveProvider,
    options: WindowsHttpOptions = {},
  ) {
    this.source = source
    this.archive = archive
    this.options = options
  }

  /** 启动完成才返回实际端口；同时启动或未完成清理时拒绝，端口冲突不会静默换端口。 */
  start(options: HttpListenOptions = {}): Promise<HttpListenerAddress> {
    if (this.server || this.registry || this.starting || this.stopping)
      throw new HttpOperationError('busy', '本地服务已启动或正在清理。')
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 0
    if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new HttpOperationError('invalid-request', '监听地址或端口无效。')
    this.starting = this.listen(host, port).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** 原生控制查询独立快照；停止后返回 null，不暗示已发布远端文件。 */
  getAddress(): HttpListenerAddress | null {
    return this.address ? { ...this.address } : null
  }

  /** 运行时网络错误只含稳定消息，调用者可显示并停止/重启服务。 */
  getError(): OperationError | null {
    return this.runtimeError ? { ...this.runtimeError } : null
  }

  /** 主进程明确重试失败缓存清理；不创建 HTTP 自动重试或重放入口。 */
  async retryCleanup(): Promise<void> {
    if (this.registry) await this.registry.retryCleanup()
    else await this.archive.retryCleanup()
  }

  /** 并发停止共用 Promise；清理失败保留注册表供再次 stop，已关闭端口不继续接纳。 */
  stop(): Promise<void> {
    if (!this.stopping)
      this.stopping = this.close().finally(() => {
        this.stopping = null
      })
    return this.stopping
  }

  private async listen(host: string, port: number): Promise<HttpListenerAddress> {
    const registry = new WindowsTransferRegistry(this.archive, this.options)
    this.registry = registry
    const sessionId = randomUUID()
    const server = createServer(
      {
        maxHeaderSize: 16384,
        highWaterMark: BATCH_RESOURCES.maxBufferBytes,
        requestTimeout: BATCH_TIMEOUTS_MS.networkIdle,
        headersTimeout: 15000,
        connectionsCheckingInterval: 1000,
        joinDuplicateHeaders: false,
      },
      (request, response) => {
        request.setTimeout(BATCH_TIMEOUTS_MS.networkIdle, () => request.destroy())
        response.setTimeout(BATCH_TIMEOUTS_MS.networkIdle, () => response.destroy())
        this.handle(request, response, registry, sessionId).catch((error: unknown) =>
          sendHttpFailure(response, error),
        )
      },
    )
    this.server = server
    this.runtimeError = null
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('clientError', (error, socket) => {
      void error
      if (socket.writable)
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      else socket.destroy()
    })
    server.on('checkContinue', (request, response) => {
      void request
      sendHttpFailure(response, new HttpOperationError('invalid-request', '不支持 Expect 请求。'))
    })
    server.on('checkExpectation', (request, response) => {
      void request
      sendHttpFailure(response, new HttpOperationError('invalid-request', '不支持 Expect 请求。'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.off('listening', ready)
          reject(error)
        }
        const ready = (): void => {
          server.off('error', failed)
          resolve()
        }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen({ host, port, exclusive: true })
      })
    } catch (error) {
      this.server = null
      await registry.stop()
      this.registry = null
      throw new HttpOperationError('io-failure', '无法监听指定地址和端口，请检查端口占用。', error)
    }
    server.on('error', (error) => {
      this.runtimeError = {
        code: 'network-failure',
        message: '本地 HTTP 服务发生网络错误，请停止后重启。',
        canRetry: false,
      }
      for (const socket of this.sockets) socket.destroy(error)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new HttpOperationError('io-failure', '本地监听地址不可用。')
    this.address = { host: address.address, port: address.port, sessionId }
    return { ...this.address }
  }

  private async close(): Promise<void> {
    if (this.starting) {
      try {
        await this.starting
      } catch {
        return
      }
    }
    const server = this.server
    const closed = server
      ? new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve()
    this.address = null
    for (const socket of this.sockets) socket.destroy()
    const registry = this.registry
    // stop 在同步部分即关闭接纳并发送 abort，再等待原生 worker。
    const stopping = registry?.stop() ?? Promise.resolve()
    const results = await Promise.allSettled([closed, stopping])
    this.server = null
    for (const result of results) if (result.status === 'rejected') throw toHttpError(result.reason)
    this.registry = null
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    registry: WindowsTransferRegistry,
    sessionId: string,
  ): Promise<void> {
    const route = inspectHttpRequest(request)
    if (route.kind !== 'device' && request.headers[HTTP_HEADERS.sessionId] !== sessionId)
      throw new HttpOperationError('session-mismatch', '服务会话已变化，请重新读取设备信息。')
    if (route.kind === 'device') {
      const device: DeviceDescriptor = {
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.source.deviceId,
        displayName: this.options.displayName ?? '存档同步 Windows',
        platform: 'windows',
        capabilities: {
          canListRoots: 'supported',
          canReadFiles: 'supported',
          canReceiveFiles: 'unsupported',
          canQueryTransfers: 'supported',
          canCancelTransfers: 'supported',
        },
      }
      sendHttpJson(response, 200, {
        status: 'success',
        value: { device, sessionId, limits: BATCH_LIMITS },
      })
      return
    }
    if (route.kind === 'roots') {
      this.sendResult(response, await this.source.listRoots())
      return
    }
    if (route.kind === 'entries' && route.id) {
      this.sendResult(response, await this.source.listDirectory(route.id, route.parentId))
      return
    }
    if (route.kind === 'downloads') {
      const value = await readHttpJson(request)
      if (!request.complete || response.destroyed) return
      sendHttpJson(response, 202, { status: 'success', value: registry.registerDownload(value) })
      return
    }
    if (!route.id) throw new HttpOperationError('invalid-request', '任务标识无效。')
    if (route.kind === 'manifest') {
      sendHttpJson(response, 200, { status: 'success', value: registry.getManifest(route.id) })
      return
    }
    if (route.kind === 'content') {
      await registry.sendContent(route.id, response)
      return
    }
    const state =
      request.method === 'DELETE' ? registry.cancel(route.id) : registry.getState(route.id)
    sendHttpJson(response, request.method === 'DELETE' && state.status === 'running' ? 202 : 200, {
      status: 'success',
      value: state,
    })
  }

  private sendResult(response: ServerResponse, result: OperationResult<unknown>): void {
    if (result.status === 'error')
      throw new HttpOperationError(result.error.code, result.error.message)
    sendHttpJson(response, 200, result)
  }
}
