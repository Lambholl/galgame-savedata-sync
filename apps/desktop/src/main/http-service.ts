import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import type { Socket } from 'node:net'
import {
  BATCH_LIMITS,
  BATCH_RESOURCES,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  isReceiveBatchRequest,
  PROTOCOL_VERSION,
  SYNC_LIMITS,
  SYNC_SCHEMA_VERSION,
  isSyncScanRequest,
  SYNC_DEVICE_HEADER,
  isOpaqueId,
} from '@savedata-sync/shared'
import type {
  BatchState,
  DeviceDescriptor,
  OperationError,
  OperationResult,
  SyncScanState,
  SyncJobState,
} from '@savedata-sync/shared'
import type { WindowsArchiveAdapter } from './archive-adapter.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { inspectHttpRequest, readHttpJson, sendHttpFailure, sendHttpJson } from './http-wire.ts'
import { WindowsTransferRegistry } from './transfer-registry.ts'
import type { TransferRegistryOptions } from './transfer-registry.ts'
import type { WindowsNewFilePublisher } from './new-file-publisher.ts'
import type { DesktopLibrary } from './library-store.ts'
import { WindowsSyncScanner } from './sync-scanner.ts'
import type { WindowsScanSource } from './sync-scanner.ts'
import { WindowsSyncRegistry } from './sync-registry.ts'
import type { WindowsSyncWriter } from './sync-writer.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import { hasTargetOperation } from './target-operation.ts'

type HttpDirectorySource = Pick<WindowsDirectoryAdapter, 'deviceId' | 'listRoots' | 'listDirectory'>
type HttpArchiveProvider = Pick<WindowsArchiveAdapter, 'prepare' | 'retryCleanup'> &
  Partial<Pick<WindowsArchiveAdapter, 'receive'>>

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
export interface WindowsHttpOptions extends Omit<TransferRegistryOptions, 'receiver'> {
  /** 接收前由本机游戏配置核实目标，恢复本进程授权；失败时拒绝本次传输。 */
  readonly authorizeTarget?: (rootId: string) => Promise<void>
  readonly library?: DesktopLibrary
  readonly displayName?: string
  readonly scanSource?: WindowsScanSource
  readonly publisher?: Pick<WindowsNewFilePublisher, 'checkTarget' | 'publish' | 'retryCleanup'>
  readonly sync?: {
    readonly writer: WindowsSyncWriter
    readonly backups: WindowsBackupStore
    readonly archive: Pick<
      WindowsArchiveAdapter,
      'prepare' | 'receive' | 'retryCleanup' | 'checkReceiveSpace'
    >
  }
}

/**
 * v1 HTTP 服务；显式注入发布适配后接收上传，写授权仍须由本机 grant，不自动重放。
 * start/stop 为受信任原生控制，界面通过有限 IPC 调用；start 失败抛脱敏 HttpOperationError。
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
  private scanner: WindowsSyncScanner | null = null
  private syncRegistry: WindowsSyncRegistry | null = null

  constructor(
    source: HttpDirectorySource,
    archive: HttpArchiveProvider,
    options: WindowsHttpOptions = {},
  ) {
    this.source = source
    this.archive = archive
    this.options = options
    if (options.scanSource && options.scanSource.deviceId !== source.deviceId) {
      throw new HttpOperationError('invalid-request', '扫描设备与服务设备不一致。')
    }
  }

  /** 启动完成才返回实际端口；同时启动或未完成清理时拒绝，端口冲突不会静默换端口。 */
  start(options: HttpListenOptions = {}): Promise<HttpListenerAddress> {
    if (this.server || this.registry || this.starting || this.stopping) {
      throw new HttpOperationError('busy', '本地服务已启动或正在清理。')
    }
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 0
    if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new HttpOperationError('invalid-request', '监听地址或端口无效。')
    }
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

  /** 本机控制读取会话内任务，不通过网络查询或延长期限。 */
  getStates(): readonly BatchState[] {
    return this.registry?.getStates() ?? []
  }
  /** 新复制的 receiver 实际结果；与旧批次状态分别查询，避免混淆公开结构。 */
  getSyncStates(): readonly SyncJobState[] {
    return this.syncRegistry?.getStates() ?? []
  }
  /** 受信任本机桥分开读取摘要、计划、清单和结果；不新增远端发起入口。 */
  syncCopies(): ReturnType<WindowsSyncRegistry['summaries']> {
    return this.syncRegistry?.summaries() ?? []
  }
  syncCopyRequest(id: string): ReturnType<WindowsSyncRegistry['localRequest']> {
    return this.localSync().localRequest(id)
  }
  syncCopyState(id: string): SyncJobState {
    return this.localSync().localState(id)
  }
  syncCopyManifest(id: string): ReturnType<WindowsSyncRegistry['localManifest']> {
    return this.localSync().localManifest(id)
  }
  cancelSyncCopy(id: string): SyncJobState {
    return this.localSync().localCancel(id)
  }
  cleanupSyncCopy(id: string): Promise<void> {
    return this.localSync().localCleanup(id)
  }
  private localSync(): WindowsSyncRegistry {
    if (!this.syncRegistry) {
      throw new HttpOperationError('not-found', '本地同步会话已关闭，请重新读取目录。')
    }
    return this.syncRegistry
  }
  /** 包含旧传输、新复制、本机恢复和待清理资源，用于编辑本机配置前检查。 */
  hasWork(): boolean {
    return hasTargetOperation()
  }
  hasRunningNetworkWork(): boolean {
    return Boolean(this.registry?.hasRunningWork() || this.syncRegistry?.hasRunningWork())
  }

  /** 本机会话扫描入口，供有限 IPC 接入；不返回句柄或平台路径。 */
  startScan(rootId: string): SyncScanState {
    return this.requireScanner().start(rootId)
  }

  /** 查询仅限当前服务会话，旧句柄不会跨重启恢复。 */
  getScan(scanId: string): SyncScanState {
    return this.requireScanner().get(scanId)
  }

  /** 显式取消只读扫描；完成状态以 worker 关闭原生流后的查询为准。 */
  cancelScan(scanId: string): SyncScanState {
    return this.requireScanner().cancel(scanId)
  }

  private requireScanner(): WindowsSyncScanner {
    if (!this.scanner || !this.address) {
      throw new HttpOperationError('unsupported-operation', '此会话未开放当前扫描。')
    }
    return this.scanner
  }

  /** 本机显式取消；不存在的任务抛脱敏错误，已发布文件保留。 */
  cancel(transferId: string): BatchState {
    if (!this.registry) {
      throw new HttpOperationError('not-found', '服务尚未启动。')
    }
    return this.registry.cancel(transferId)
  }

  /** 主进程明确重试失败缓存清理；不创建 HTTP 自动重试或重放入口。 */
  async retryCleanup(): Promise<void> {
    if (this.syncRegistry?.hasWork()) {
      await this.syncRegistry.retryCleanup()
    }
    if (this.registry) {
      await this.registry.retryCleanup()
    } else {
      await this.archive.retryCleanup()
      await this.options.publisher?.retryCleanup()
    }
  }

  /** 并发停止共用 Promise；清理失败保留注册表供再次 stop，已关闭端口不继续接纳。 */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.close().finally(() => {
        this.stopping = null
      })
    }
    return this.stopping
  }

  private async listen(host: string, port: number): Promise<HttpListenerAddress> {
    this.scanner = this.options.scanSource ? new WindowsSyncScanner(this.options.scanSource) : null
    const registry = new WindowsTransferRegistry(this.archive, {
      ...this.options,
      ...(this.options.publisher && this.archive.receive
        ? {
            receiver: {
              archive: {
                receive: this.archive.receive.bind(this.archive),
                retryCleanup: this.archive.retryCleanup.bind(this.archive),
              },
              publisher: this.options.publisher,
            },
          }
        : {}),
    })
    this.registry = registry
    if (this.options.sync && this.options.library && this.scanner && this.options.scanSource) {
      this.syncRegistry = new WindowsSyncRegistry({
        ...this.options.sync,
        library: this.options.library,
        scanner: this.scanner,
        source: this.options.scanSource,
        deviceId: this.source.deviceId,
        ...(this.options.timeouts ? { timeouts: this.options.timeouts } : {}),
      })
    }
    const sessionId = randomUUID()
    const server = createServer(
      {
        maxHeaderSize: 16384,
        highWaterMark: BATCH_RESOURCES.maxBufferBytes,
        requestTimeout: BATCH_TIMEOUTS_MS.total,
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
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } else {
        socket.destroy()
      }
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
      await this.syncRegistry?.stop()
      this.syncRegistry = null
      await this.scanner?.stop()
      this.scanner = null
      this.registry = null
      throw new HttpOperationError('io-failure', '无法监听指定地址和端口，请检查端口占用。', error)
    }
    server.on('error', (error) => {
      this.runtimeError = {
        code: 'network-failure',
        message: '本地 HTTP 服务发生网络错误，请停止后重启。',
        canRetry: false,
      }
      for (const socket of this.sockets) {
        socket.destroy(error)
      }
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new HttpOperationError('io-failure', '本地监听地址不可用。')
    }
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
    for (const socket of this.sockets) {
      socket.destroy()
    }
    const registry = this.registry
    // stop 在同步部分即关闭接纳并发送 abort，再等待原生 worker。
    const stopping = registry?.stop() ?? Promise.resolve()
    const results = await Promise.allSettled([
      closed,
      stopping,
      this.syncRegistry?.stop(),
      this.scanner?.stop(),
    ])
    this.server = null
    for (const result of results) {
      if (result.status === 'rejected') {
        throw toHttpError(result.reason)
      }
    }
    this.registry = null
    this.scanner = null
    this.syncRegistry = null
    this.options.library?.stop()
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    registry: WindowsTransferRegistry,
    sessionId: string,
  ): Promise<void> {
    const route = inspectHttpRequest(request)
    if (route.kind !== 'device' && request.headers[HTTP_HEADERS.sessionId] !== sessionId) {
      throw new HttpOperationError('session-mismatch', '服务会话已变化，请重新读取设备信息。')
    }
    const isSyncPeerRequired = [
      'sync-project',
      'sync-jobs',
      'sync-job',
      'sync-job-manifest',
      'sync-job-content',
    ].includes(route.kind)
    const peerId = request.headers[SYNC_DEVICE_HEADER]
    if (isSyncPeerRequired && (!isOpaqueId(peerId) || !this.syncRegistry)) {
      throw new HttpOperationError(
        this.syncRegistry ? 'invalid-request' : 'unsupported-operation',
        '同步设备标识无效或服务未开放复制。',
      )
    }
    if (route.kind.startsWith('sync-') && peerId !== undefined) {
      if (!isOpaqueId(peerId) || !this.options.library) {
        throw new HttpOperationError('invalid-request', '同步设备标识无效。')
      }
      this.options.library.touchPeer(peerId)
    }
    if (isSyncPeerRequired && isOpaqueId(peerId) && this.syncRegistry) {
      const jobs = this.syncRegistry
      if (route.kind === 'sync-project' && route.id) {
        sendHttpJson(response, 200, {
          status: 'success',
          value: await jobs.project(route.id, peerId),
        })
      } else if (route.kind === 'sync-jobs') {
        const value = await readHttpJson(request)
        if (request.complete && !response.destroyed) {
          sendHttpJson(response, 201, {
            status: 'success',
            value: await jobs.register(value, peerId),
          })
        }
      } else if (route.id) {
        if (route.kind === 'sync-job-manifest') {
          if (request.method === 'PUT') {
            const value = await readHttpJson(request)
            if (request.complete && !response.destroyed) {
              sendHttpJson(response, 200, {
                status: 'success',
                value: await jobs.declare(route.id, peerId, value),
              })
            }
          } else {
            sendHttpJson(response, 200, {
              status: 'success',
              value: jobs.manifest(route.id, peerId),
            })
          }
        } else if (route.kind === 'sync-job-content') {
          if (request.method === 'GET') {
            await jobs.sendContent(route.id, peerId, response)
          } else {
            sendHttpJson(response, 202, {
              status: 'success',
              value: await jobs.receive(route.id, peerId, request, response),
            })
          }
        } else {
          const state =
            request.method === 'DELETE' ? jobs.cancel(route.id, peerId) : jobs.get(route.id, peerId)
          sendHttpJson(
            response,
            request.method === 'DELETE' && state.status === 'running' ? 202 : 200,
            { status: 'success', value: state },
          )
        }
      }
      return
    }
    if (route.kind === 'device') {
      const device: DeviceDescriptor = {
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.source.deviceId,
        displayName: this.options.displayName ?? hostname(),
        platform: 'windows',
        capabilities: {
          canListRoots: 'supported',
          canReadFiles: 'supported',
          canReceiveFiles:
            this.options.publisher && this.archive.receive ? 'supported' : 'unsupported',
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
    if (route.kind === 'sync-capabilities') {
      sendHttpJson(response, 200, {
        status: 'success',
        value: {
          schemaVersion: SYNC_SCHEMA_VERSION,
          deviceId: this.source.deviceId,
          canScan: this.scanner ? 'supported' : 'unsupported',
          canCopy: this.syncRegistry ? 'supported' : 'unsupported',
          canBackup: this.syncRegistry ? 'supported' : 'unsupported',
          canRestore: 'unsupported',
          limits: SYNC_LIMITS,
        },
      })
      return
    }
    if (route.kind === 'sync-scans') {
      const value = await readHttpJson(request)
      if (!isSyncScanRequest(value)) {
        throw new HttpOperationError('invalid-request', '当前扫描请求无效。')
      }
      if (!request.complete || response.destroyed) {
        return
      }
      sendHttpJson(response, 202, { status: 'success', value: this.startScan(value.rootId) })
      return
    }
    if (route.kind === 'sync-scan' && route.id) {
      const value = request.method === 'DELETE' ? this.cancelScan(route.id) : this.getScan(route.id)
      sendHttpJson(
        response,
        request.method === 'DELETE' && value.status === 'running' ? 202 : 200,
        { status: 'success', value },
      )
      return
    }
    if (route.kind === 'entries' && route.id) {
      this.sendResult(response, await this.source.listDirectory(route.id, route.parentId))
      return
    }
    if (route.kind === 'catalog') {
      if (!this.options.library) {
        throw new HttpOperationError('unsupported-operation', '此版本未开放游戏目录表。')
      }
      const value = await readHttpJson(request)
      if (!request.complete || response.destroyed) {
        return
      }
      sendHttpJson(response, 200, {
        status: 'success',
        value: await this.options.library.exchange(
          value,
          registry.getStates().some((item) => item.status === 'running') ||
            Boolean(this.syncRegistry?.hasWork()),
          request.headers['x-sync-connect'] === '1',
        ),
      })
      return
    }
    if (route.kind === 'downloads') {
      const value = await readHttpJson(request)
      if (!request.complete || response.destroyed) {
        return
      }
      sendHttpJson(response, 202, { status: 'success', value: registry.registerDownload(value) })
      return
    }
    if (route.kind === 'uploads') {
      const value = await readHttpJson(request)
      if (!request.complete || response.destroyed) {
        return
      }
      if (this.options.authorizeTarget) {
        if (!isReceiveBatchRequest(value)) {
          throw new HttpOperationError('invalid-request', '接收请求无效。')
        }
        await this.options.authorizeTarget(value.targetRootId)
      }
      sendHttpJson(response, 201, {
        status: 'success',
        value: await registry.registerUpload(value),
      })
      return
    }
    if (!route.id) {
      throw new HttpOperationError('invalid-request', '任务标识无效。')
    }
    if (route.kind === 'manifest') {
      sendHttpJson(response, 200, { status: 'success', value: registry.getManifest(route.id) })
      return
    }
    if (route.kind === 'content') {
      if (request.method === 'PUT') {
        sendHttpJson(response, 202, {
          status: 'success',
          value: await registry.receiveContent(route.id, request, response),
        })
      } else {
        await registry.sendContent(route.id, response)
      }
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
    if (result.status === 'error') {
      throw new HttpOperationError(result.error.code, result.error.message)
    }
    sendHttpJson(response, 200, result)
  }
}
