import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  CONTROL_ROUTE,
  BATCH_LIMITS,
  BATCH_RESOURCES,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  isReceiveBatchRequest,
  PROTOCOL_VERSION,
  SYNC_CAPABILITIES_VERSION,
  SYNC_LIMITS,
  isSyncScanRequest,
  SYNC_DEVICE_HEADER,
  isOpaqueId,
} from '@savedata-sync/shared'
import type {
  BatchState,
  DeviceDescriptor,
  OperationError,
  OperationResult,
  SyncJobDigest,
  SyncScanState,
  SyncJobState,
  SyncTransferState,
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
import { WindowsRemoteSyncRequests } from './remote-sync-requests.ts'
import { ControlHub } from './control-hub.ts'
import type { WindowsSyncWriter } from './sync-writer.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import { hasTargetOperation } from './target-operation.ts'

type HttpDirectorySource = Pick<WindowsDirectoryAdapter, 'deviceId' | 'listRoots' | 'listDirectory'>
type HttpArchiveProvider = Pick<WindowsArchiveAdapter, 'prepare' | 'retryCleanup'> &
  Partial<Pick<WindowsArchiveAdapter, 'receive'>>

/** 监听选项；缺省时监听回环地址和动态端口。 */
export interface HttpListenOptions {
  readonly host?: string
  readonly port?: number
}

/** 监听地址快照。sessionId 每次启动重新生成。 */
export interface HttpListenerAddress {
  readonly host: string
  readonly port: number
  readonly sessionId: string
  /** 开始监听的时间（Unix 毫秒）。 */
  readonly startedAt: number
}

/** HTTP 服务的选项；限额和时钟的含义同 TransferRegistryOptions。 */
export interface WindowsHttpOptions extends Omit<TransferRegistryOptions, 'receiver'> {
  /** 接收前核实目标并恢复写授权；reject 时拒绝本次传输。 */
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

/** 本机 v1 HTTP 服务，提供批量传输、复制任务、远程复制请求和控制通道。提供发布适配器时才接收上传。 */
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
  private remoteRequests: WindowsRemoteSyncRequests | null = null
  private control: ControlHub | null = null

  constructor(
    source: HttpDirectorySource,
    archive: HttpArchiveProvider,
    options: WindowsHttpOptions = {},
  ) {
    this.source = source
    this.archive = archive
    this.options = options
    if (options.scanSource && options.scanSource.deviceId !== source.deviceId) {
      throw new HttpOperationError(
        'invalid-request',
        'The scan device does not match the service device.',
      )
    }
  }

  /**
   * 启动监听。
   *
   * @returns 实际监听的地址和端口。
   * @throws HttpOperationError 已在运行、清理未完成或端口冲突时抛出。
   */
  start(options: HttpListenOptions = {}): Promise<HttpListenerAddress> {
    if (this.server || this.registry || this.starting || this.stopping) {
      throw new HttpOperationError(
        'busy',
        'The local service is already running or is cleaning up.',
      )
    }
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 0
    if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new HttpOperationError('invalid-request', 'The listening address or port is invalid.')
    }
    this.starting = this.listen(host, port).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** 返回监听地址快照；停止后返回 null。 */
  getAddress(): HttpListenerAddress | null {
    return this.address ? { ...this.address } : null
  }

  /** 返回运行时的网络错误；没有错误时为 null。 */
  getError(): OperationError | null {
    return this.runtimeError ? { ...this.runtimeError } : null
  }

  /** 返回当前会话的批量传输状态；读取不延长任务期限。 */
  getStates(): readonly BatchState[] {
    return this.registry?.getStates() ?? []
  }
  /** 返回当前会话复制任务在本机这一端的状态，包括本机作为接收端和发送端的任务。 */
  getSyncStates(): readonly SyncJobState[] {
    return this.syncRegistry?.getStates() ?? []
  }
  /** 读取本机发起的复制请求；没有请求或服务没运行时为 null。服务停止时请求一并丢弃。 */
  remoteSyncRequest(): ReturnType<WindowsRemoteSyncRequests['state']> {
    return this.remoteRequests?.state() ?? null
  }
  /**
   * 请已连接的移动端扫描并准备复制。
   *
   * @throws HttpOperationError 服务没运行时抛出，错误码为 unsupported-operation。
   */
  startRemoteSync(
    projectId: string,
    peerId: string,
    direction: 'android-to-windows' | 'windows-to-android',
  ): ReturnType<WindowsRemoteSyncRequests['start']> {
    return this.requireRemote().start(projectId, peerId, direction)
  }
  /** 读取移动端回报的计划；服务没运行时抛错。 */
  remoteSyncPlan(requestId: string): ReturnType<WindowsRemoteSyncRequests['plan']> {
    return this.requireRemote().plan(requestId)
  }
  /** 确认计划并让移动端开始执行；服务没运行时抛错。 */
  confirmRemoteSync(
    requestId: string,
    shouldDeleteExtras: boolean,
  ): ReturnType<WindowsRemoteSyncRequests['confirm']> {
    return this.requireRemote().confirm(requestId, shouldDeleteExtras)
  }
  /** 取消发起的请求；服务没运行时抛错。 */
  cancelRemoteSync(requestId: string): ReturnType<WindowsRemoteSyncRequests['cancel']> {
    return this.requireRemote().cancel(requestId)
  }
  private requireRemote(): WindowsRemoteSyncRequests {
    if (!this.remoteRequests) {
      throw new HttpOperationError(
        'unsupported-operation',
        'Start the local service on the Devices page first.',
      )
    }
    return this.remoteRequests
  }
  /** 返回复制任务的摘要列表，包括还没登记的本机发起任务。 */
  syncCopies(): ReturnType<WindowsSyncRegistry['summaries']> {
    const pending = this.remoteRequests?.pending()
    return [...(this.syncRegistry?.summaries() ?? []), ...(pending ? [pending.summary] : [])]
  }
  /** 返回 ID 为 id、还没登记的本机发起任务；没有时为 null。 */
  private pendingCopy(id: string): ReturnType<WindowsRemoteSyncRequests['pending']> {
    const pending = this.remoteRequests?.pending()
    return pending?.request.jobId === id ? pending : null
  }
  /** 读取复制任务的登记请求；服务会话已结束时抛出 not-found 错误。 */
  syncCopyRequest(id: string): ReturnType<WindowsSyncRegistry['localRequest']> {
    return this.pendingCopy(id)?.request ?? this.localSync().localRequest(id)
  }
  /** 读取复制任务的状态；服务会话已结束时抛出 not-found 错误。 */
  syncCopyState(id: string): SyncTransferState {
    return this.pendingCopy(id)?.state ?? this.localSync().localState(id)
  }
  /** 读取复制任务的清单；服务会话已结束时抛出 not-found 错误。 */
  syncCopyManifest(id: string): ReturnType<WindowsSyncRegistry['localManifest']> {
    return this.localSync().localManifest(id)
  }
  /** 取消复制任务，包括还没登记的本机发起任务。 */
  async cancelSyncCopy(id: string): Promise<SyncTransferState> {
    const pending = this.pendingCopy(id)
    if (pending) {
      await this.requireRemote().cancelPending(id)
      return pending.state
    }
    return this.localSync().localCancel(id)
  }
  /** 重试复制任务的缓存清理；服务会话已结束时抛出 not-found 错误。 */
  cleanupSyncCopy(id: string): Promise<void> {
    return this.localSync().localCleanup(id)
  }
  private localSync(): WindowsSyncRegistry {
    if (!this.syncRegistry) {
      throw new HttpOperationError(
        'not-found',
        'The local sync session closed. Read the directory again.',
      )
    }
    return this.syncRegistry
  }
  /** 判断是否有批量传输、复制任务、本机恢复或待清理的资源。 */
  hasWork(): boolean {
    return hasTargetOperation()
  }
  /** 判断是否有正在运行的批量传输或复制任务。 */
  hasRunningNetworkWork(): boolean {
    return Boolean(this.registry?.hasRunningWork() || this.syncRegistry?.hasRunningWork())
  }

  /** 开始扫描一个本机根目录。 */
  startScan(rootId: string): SyncScanState {
    return this.requireScanner().start(rootId)
  }

  /** 读取扫描状态；scanId 只在当前服务会话内有效。 */
  getScan(scanId: string): SyncScanState {
    return this.requireScanner().get(scanId)
  }

  /** 取消扫描；返回的状态可能还不是最终状态，扫描线程关闭文件后才是。 */
  cancelScan(scanId: string): SyncScanState {
    return this.requireScanner().cancel(scanId)
  }

  private requireScanner(): WindowsSyncScanner {
    if (!this.scanner || !this.address) {
      throw new HttpOperationError(
        'unsupported-operation',
        'This scan is not available in the current session.',
      )
    }
    return this.scanner
  }

  /** 取消批量传输，已发布的文件保留；任务不存在时抛错。 */
  cancel(transferId: string): BatchState {
    if (!this.registry) {
      throw new HttpOperationError('not-found', 'The service has not started.')
    }
    return this.registry.cancel(transferId)
  }

  /** 重试失败的缓存清理。 */
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

  /** 停止服务：关闭所有连接，取消并等待任务和缓存清理；并发调用共用同一个 Promise。清理失败时端口已关闭，可以再次 stop。 */
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
    if (this.options.library) {
      const control = new ControlHub()
      this.control = control
      this.options.library.attachControl(control)
      if (this.options.sync && this.scanner && this.options.scanSource) {
        const jobs = new WindowsSyncRegistry({
          ...this.options.sync,
          library: this.options.library,
          scanner: this.scanner,
          source: this.options.scanSource,
          deviceId: this.source.deviceId,
          control,
          ...(this.options.timeouts ? { timeouts: this.options.timeouts } : {}),
        })
        this.syncRegistry = jobs
        const remote = new WindowsRemoteSyncRequests({
          library: this.options.library,
          control,
          deviceId: this.source.deviceId,
          isBusy: () => this.hasRunningNetworkWork(),
          hasJob: (jobId) => jobs.has(jobId),
        })
        this.remoteRequests = remote
        control.subscribe({
          event: (peerId, method, body) => {
            if (method === 'sync.report') {
              remote.report(peerId, body as Parameters<typeof remote.report>[1])
            } else if (method === 'sync.job') {
              const digest = body as SyncJobDigest
              remote.observe(peerId, digest)
              jobs.observe(peerId, digest)
            }
          },
          closed: (peerId) => remote.closed(peerId),
        })
      }
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
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.upgrade(request, socket, head, sessionId),
    )
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
      sendHttpFailure(
        response,
        new HttpOperationError('invalid-request', 'Expect requests are not supported.'),
      )
    })
    server.on('checkExpectation', (request, response) => {
      void request
      sendHttpFailure(
        response,
        new HttpOperationError('invalid-request', 'Expect requests are not supported.'),
      )
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
      this.remoteRequests = null
      this.stopControl()
      await this.scanner?.stop()
      this.scanner = null
      this.registry = null
      throw new HttpOperationError(
        'io-failure',
        'Cannot listen on the specified address and port. Check whether the port is in use.',
        error,
      )
    }
    server.on('error', (error) => {
      this.runtimeError = {
        code: 'network-failure',
        message: 'The local HTTP service encountered a network error. Stop and restart it.',
        canRetry: false,
      }
      for (const socket of this.sockets) {
        socket.destroy(error)
      }
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new HttpOperationError('io-failure', 'The local listening address is unavailable.')
    }
    this.address = { host: address.address, port: address.port, sessionId, startedAt: Date.now() }
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
    this.remoteRequests = null
    this.stopControl()
    // registry.stop 在同步部分就停止接纳并发送 abort，之后才等待原生 worker。
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

  private stopControl(): void {
    this.control?.stop()
    this.control = null
    this.options.library?.attachControl(null)
  }

  /** 处理控制通道的升级请求，只接受本会话已交换目录表的设备。 */
  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): void {
    const peerId = request.headers[SYNC_DEVICE_HEADER]
    if (
      !this.control ||
      request.method !== 'GET' ||
      request.url !== CONTROL_ROUTE ||
      request.headers[HTTP_HEADERS.sessionId] !== sessionId ||
      !isOpaqueId(peerId) ||
      !this.options.library?.canControl(peerId)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    this.control.accept(request, socket, head, peerId)
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    registry: WindowsTransferRegistry,
    sessionId: string,
  ): Promise<void> {
    const route = inspectHttpRequest(request)
    if (route.kind !== 'device' && request.headers[HTTP_HEADERS.sessionId] !== sessionId) {
      throw new HttpOperationError(
        'session-mismatch',
        'The service session changed. Read device information again.',
      )
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
        'The sync device ID is invalid or copying is not enabled on the service.',
      )
    }
    if (route.kind.startsWith('sync-') && peerId !== undefined) {
      if (!isOpaqueId(peerId) || !this.options.library) {
        throw new HttpOperationError('invalid-request', 'The sync device ID is invalid.')
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
          schemaVersion: SYNC_CAPABILITIES_VERSION,
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
        throw new HttpOperationError('invalid-request', 'The current scan request is invalid.')
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
        throw new HttpOperationError(
          'unsupported-operation',
          'This version does not provide a game catalog.',
        )
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
          throw new HttpOperationError('invalid-request', 'The receive request is invalid.')
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
      throw new HttpOperationError('invalid-request', 'The task ID is invalid.')
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
