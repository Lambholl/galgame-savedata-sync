import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  BATCH_LIMITS,
  BATCH_RESOURCES,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  isBatchManifest,
  isDownloadBatchRequest,
  isReceiveBatchRequest,
  isBatchState,
  matchesBatchState,
  isSha256,
} from '@savedata-sync/shared'
import type {
  BatchManifest,
  BatchProgress,
  BatchRunningState,
  BatchState,
  DownloadBatchRequest,
  KnownOperationError,
  OperationError,
  FileOutcome,
  ReceiveBatchRequest,
} from '@savedata-sync/shared'
import type { WindowsArchive, WindowsArchiveAdapter } from './archive-adapter.ts'
import { ArchiveCancelledError } from './archive-errors.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { WindowsUploadReceiver, publicationRequests } from './upload-receiver.ts'
import type { ReceiverDependencies, ReceiverCompletion } from './upload-receiver.ts'

type ArchiveProvider = Pick<WindowsArchiveAdapter, 'prepare' | 'retryCleanup'>
type TransferTimeouts = Pick<
  typeof BATCH_TIMEOUTS_MS,
  'ready' | 'awaitingContent' | 'total' | 'networkIdle' | 'terminalRetention'
>

/** 原生时钟及收紧预算只供可信主进程/测试注入；不能由 HTTP 请求配置。 */
export interface TransferRegistryOptions {
  readonly now?: () => number
  readonly timeouts?: { readonly [Key in keyof TransferTimeouts]?: number }
  readonly maxTransfers?: number
  readonly receiver?: ReceiverDependencies
}

interface TransferTask {
  state: BatchState
  manifest: BatchManifest | null
  artifact: WindowsArchive | null
  readonly controller: AbortController
  readonly acceptedAt: number
  stageAt: number
  networkAt: number
  terminalAt: number | null
  reason: KnownOperationError | null
  worker: Promise<void>
  finishing: Promise<void> | null
  receiverRequest: ReceiveBatchRequest | null
  receiver: WindowsUploadReceiver | null
}

// 原生控制可构造多个监听实例，但同一进程仍只能有一个活动批次。
let activeTransferOwner: symbol | null = null

function operation(code: KnownOperationError['code'], message: string): KnownOperationError {
  return { code, message, canRetry: false }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 会话内注册、单次领取和取消的原生边界；仅 sender 下载已接入。
 * 一个活动任务覆盖准备至清理；终态到期删除清单/结果，已用 ID 保留到 stop。
 * stop 必须等待文件/HTTP worker 收尾；清理失败保留互斥，可明确 retryCleanup。
 * API 示例及调用顺序见桌面 README 的 HTTP 节，不持久化任务或历史哈希。
 */
export class WindowsTransferRegistry {
  private readonly ownership = Symbol('transfer-registry')
  private readonly tasks = new Map<string, TransferTask>()
  private readonly usedIds = new Set<string>()
  private readonly archive: ArchiveProvider
  private readonly now: () => number
  private readonly timeouts: { [Key in keyof TransferTimeouts]: number }
  private readonly maxTransfers: number
  private readonly timer: ReturnType<typeof setInterval>
  private readonly receiver: ReceiverDependencies | undefined
  private pendingId: string | null = null
  private pendingRegistration: Promise<BatchState> | null = null
  private activeId: string | null = null
  private isStopped = false

  constructor(archive: ArchiveProvider, options: TransferRegistryOptions = {}) {
    this.archive = archive
    this.receiver = options.receiver
    this.now = options.now ?? Date.now
    this.timeouts = { ...BATCH_TIMEOUTS_MS, ...options.timeouts }
    this.maxTransfers = options.maxTransfers ?? BATCH_LIMITS.maxTransfersPerSession
    if (
      !Number.isSafeInteger(this.maxTransfers) ||
      this.maxTransfers < 1 ||
      this.maxTransfers > BATCH_LIMITS.maxTransfersPerSession
    ) {
      throw new HttpOperationError('invalid-request', '任务容量配置无效。')
    }
    for (const key of [
      'ready',
      'awaitingContent',
      'total',
      'networkIdle',
      'terminalRetention',
    ] as const) {
      if (
        !Number.isSafeInteger(this.timeouts[key]) ||
        this.timeouts[key] < 1 ||
        this.timeouts[key] > BATCH_TIMEOUTS_MS[key]
      ) {
        throw new HttpOperationError('invalid-request', '任务期限配置无效。')
      }
    }
    this.timer = setInterval(() => this.sweep(), Math.min(1000, ...Object.values(this.timeouts)))
    this.timer.unref()
  }

  /** 格式验证成功后同步占用 ID/活动名额；异步准备失败也不允许重用 ID。 */
  registerDownload(value: unknown): BatchState {
    if (!isDownloadBatchRequest(value)) {
      const mismatch =
        value &&
        typeof value === 'object' &&
        'protocolVersion' in value &&
        value.protocolVersion !== 1
      throw new HttpOperationError(
        mismatch ? 'protocol-mismatch' : 'invalid-request',
        '下载批次请求无效。',
      )
    }
    this.assertAvailable(value.transferId)
    const request = clone(value)
    const at = this.now()
    const state: BatchRunningState = {
      transferId: request.transferId,
      direction: 'windows-to-android',
      role: 'sender',
      updatedAt: at,
      status: 'running',
      stage: 'preparing',
      cancelRequested: false,
      fileResults: null,
      progress: {
        sourceBytesRead: 0,
        archiveBytesTransferred: 0,
        fileBytesVerified: 0,
        fileBytesPublished: 0,
        totalFileBytes: null,
        totalArchiveBytes: null,
        totalFiles: request.files.length,
        verifiedFiles: 0,
        publishedFiles: 0,
      },
    }
    const task: TransferTask = {
      state,
      manifest: null,
      artifact: null,
      controller: new AbortController(),
      acceptedAt: at,
      stageAt: at,
      networkAt: at,
      terminalAt: null,
      reason: null,
      worker: Promise.resolve(),
      finishing: null,
      receiverRequest: null,
      receiver: null,
    }
    this.usedIds.add(request.transferId)
    this.activeId = request.transferId
    activeTransferOwner = this.ownership
    this.tasks.set(request.transferId, task)
    task.worker = Promise.resolve().then(() => this.prepare(task, request))
    return clone(state)
  }

  /** 上传先只读预检全部目标；异步预检期间保留进程名额，拒绝后不占用已用 ID。 */
  registerUpload(value: unknown): Promise<BatchState> {
    if (!isReceiveBatchRequest(value)) {
      const mismatch =
        value &&
        typeof value === 'object' &&
        'protocolVersion' in value &&
        value.protocolVersion !== 1
      throw new HttpOperationError(
        mismatch ? 'protocol-mismatch' : 'invalid-request',
        '上传登记请求无效。',
      )
    }
    if (!this.receiver) {
      throw new HttpOperationError('unsupported-operation', '未启用原生接收能力。')
    }
    const request = clone(value)
    this.assertAvailable(request.manifest.transferId)
    this.pendingId = request.manifest.transferId
    activeTransferOwner = this.ownership
    this.pendingRegistration = this.prepareUpload(request, this.receiver).finally(() => {
      this.pendingId = null
      this.pendingRegistration = null
      if (this.activeId === null && activeTransferOwner === this.ownership) {
        activeTransferOwner = null
      }
    })
    return this.pendingRegistration
  }

  private async prepareUpload(
    request: ReceiveBatchRequest,
    receiver: ReceiverDependencies,
  ): Promise<BatchState> {
    const targets = new Set<string>()
    for (const file of publicationRequests(request)) {
      const key = await receiver.publisher.checkTarget(file)
      if (targets.has(key)) {
        throw new HttpOperationError('name-conflict', '多个文件映射到相同实际目标。')
      }
      targets.add(key)
    }
    if (this.isStopped) {
      throw new HttpOperationError('busy', '服务正在停止。')
    }
    const at = this.now()
    const state: BatchRunningState = {
      transferId: request.manifest.transferId,
      direction: 'android-to-windows',
      role: 'receiver',
      updatedAt: at,
      status: 'running',
      stage: 'awaiting-content',
      cancelRequested: false,
      fileResults: [],
      progress: {
        sourceBytesRead: 0,
        archiveBytesTransferred: 0,
        fileBytesVerified: 0,
        fileBytesPublished: 0,
        totalFileBytes: request.manifest.totalFileBytes,
        totalArchiveBytes: request.manifest.archive.sizeBytes,
        totalFiles: request.manifest.files.length,
        verifiedFiles: 0,
        publishedFiles: 0,
      },
    }
    const task: TransferTask = {
      state,
      manifest: request.manifest,
      artifact: null,
      controller: new AbortController(),
      acceptedAt: at,
      stageAt: at,
      networkAt: at,
      terminalAt: null,
      reason: null,
      worker: Promise.resolve(),
      finishing: null,
      receiverRequest: request,
      receiver: null,
    }
    task.receiver = new WindowsUploadReceiver(request, receiver, {
      signal: task.controller.signal,
      state: () => clone(task.state),
      reason: () => task.reason,
      networkProgress: () => {
        task.networkAt = this.now()
      },
      abort: (reason) => this.abort(task, reason),
      ownArchive: (artifact) => {
        task.artifact = artifact
      },
      progress: (stage, progress, results) => {
        if (task.state.status === 'running' && task.state.role === 'receiver') {
          task.state = { ...task.state, fileResults: results }
          this.running(task, stage, progress)
        }
      },
      complete: (completion) => this.completeReceiver(task, completion),
    })
    this.tasks.set(state.transferId, task)
    this.usedIds.add(state.transferId)
    this.activeId = state.transferId
    return clone(state)
  }

  /** 请求头匹配登记清单后同步领取唯一 PUT；重复或错误方向不消耗原生输入。 */
  receiveContent(
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<BatchState> {
    const task = this.find(id)
    if (
      task.state.status !== 'running' ||
      task.state.role !== 'receiver' ||
      task.state.stage !== 'awaiting-content' ||
      !task.receiver ||
      !task.manifest
    ) {
      throw new HttpOperationError('task-conflict', '该任务当前不接受上传内容。')
    }
    const length = request.headers['content-length']
    const hash = request.headers[HTTP_HEADERS.archiveSha256]
    if (
      request.headers['transfer-encoding'] !== undefined ||
      typeof length !== 'string' ||
      typeof request.headers['content-type'] !== 'string' ||
      request.headers['content-type'].toLowerCase() !== 'application/gzip' ||
      !isSha256(hash)
    ) {
      throw new HttpOperationError('invalid-request', '上传内容头无效。')
    }
    if (Number(length) > BATCH_LIMITS.maxArchiveBytes) {
      throw new HttpOperationError('resource-limit', '上传体超过协议预算。')
    }
    if (
      Number(length) !== task.manifest.archive.sizeBytes ||
      hash !== task.manifest.archive.sha256
    ) {
      throw new HttpOperationError('checksum-mismatch', '上传头与登记清单不符。')
    }
    this.running(task, 'transferring')
    task.networkAt = this.now()
    const receive = task.receiver.receive(request, response)
    task.worker = receive.worker
    return receive.accepted
  }

  private assertAvailable(id: string): void {
    this.sweep()
    if (this.isStopped) {
      throw new HttpOperationError('busy', '服务正在停止。')
    }
    if (this.usedIds.has(id) || this.pendingId === id) {
      throw new HttpOperationError('task-conflict', '本会话已使用或正在登记该任务标识。')
    }
    if (activeTransferOwner !== null) {
      throw new HttpOperationError('busy', '已有活动批次或缓存等待清理。')
    }
    if (this.usedIds.size >= this.maxTransfers) {
      throw new HttpOperationError('resource-limit', '会话任务标识容量已满，请重新启动服务。')
    }
  }

  /** 查询返回独立快照，不改变期限；不存在/到期均不证明远端未写入。 */
  getState(id: string): BatchState {
    return clone(this.find(id).state)
  }

  /** 本机界面读取当前会话快照；遵守既有到期清理，不延长任务保留期。 */
  getStates(): readonly BatchState[] {
    this.sweep()
    return [...this.tasks.values()].map((task) => clone(task.state))
  }

  /** 仅在 ready 之后或仍保留清单的终态可读，准备阶段返回 task-conflict。 */
  getManifest(id: string): BatchManifest {
    const task = this.find(id)
    if (!task.manifest) {
      throw new HttpOperationError('task-conflict', '任务清单尚不可用。')
    }
    return clone(task.manifest)
  }

  /** 取消请求不预先终结正在执行的 IO，清理完成后才释放活动名额。 */
  cancel(id: string): BatchState {
    const task = this.find(id)
    this.abort(task, null)
    return clone(task.state)
  }

  /** 原子领取后再打开原生流；调用者持有响应，Promise 覆盖流发送和缓存清理。 */
  sendContent(id: string, response: ServerResponse): Promise<void> {
    const task = this.find(id)
    if (
      task.state.status !== 'running' ||
      task.state.role !== 'sender' ||
      task.state.stage !== 'ready' ||
      !task.artifact
    ) {
      throw new HttpOperationError('task-conflict', '任务内容已领取或当前阶段不允许领取。')
    }
    this.running(task, 'transferring')
    task.networkAt = this.now()
    task.worker = this.send(task, response)
    return task.worker
  }

  /** 实际时钟和测试时钟共用期限检查；轮询不会刷新 acceptedAt/stageAt/networkAt。 */
  sweep(): void {
    const now = this.now()
    for (const [id, task] of this.tasks) {
      if (task.terminalAt !== null) {
        if (now - task.terminalAt >= this.timeouts.terminalRetention) {
          task.manifest = null
          task.receiverRequest = null
          task.receiver = null
          this.tasks.delete(id)
        }
        continue
      }
      if (task.state.status !== 'running' || task.state.stage === 'cleaning') {
        continue
      }
      if (
        now - task.acceptedAt >= this.timeouts.total ||
        (task.state.stage === 'ready' && now - task.stageAt >= this.timeouts.ready) ||
        (task.state.stage === 'awaiting-content' &&
          now - task.stageAt >= this.timeouts.awaitingContent) ||
        (task.state.stage === 'transferring' && now - task.networkAt >= this.timeouts.networkIdle)
      ) {
        this.abort(task, operation('timeout', '批次操作超过期限。'))
      }
    }
  }

  /** 仅重试确知所有权的归档缓存；成功后更新仍保留的终态并释放互斥。 */
  async retryCleanup(): Promise<void> {
    const id = this.activeId
    if (id === null) {
      return
    }
    const task = this.tasks.get(id)
    if (task?.state.status === 'running') {
      throw new HttpOperationError('busy', '任务仍在使用缓存。')
    }
    await this.archive.retryCleanup()
    await this.receiver?.archive.retryCleanup()
    await this.receiver?.publisher.retryCleanup()
    if (task) {
      task.state = {
        ...task.state,
        cleanupStatus: 'complete',
        cleanupError: null,
        updatedAt: this.now(),
      }
    }
    this.activeId = null
    if (activeTransferOwner === this.ownership) {
      activeTransferOwner = null
    }
  }

  /** 停止接纳、取消并等待当前 worker，最后释放缓存；失败由主进程明确处理。 */
  async stop(): Promise<void> {
    this.isStopped = true
    clearInterval(this.timer)
    if (this.pendingRegistration) {
      await this.pendingRegistration.catch(() => undefined)
    }
    for (const task of this.tasks.values()) {
      this.abort(task, null)
    }
    await Promise.all([...this.tasks.values()].map((task) => task.worker.catch(() => undefined)))
    await this.retryCleanup()
    this.tasks.clear()
    this.usedIds.clear()
  }

  private find(id: string): TransferTask {
    this.sweep()
    const task = this.tasks.get(id)
    if (!task) {
      throw new HttpOperationError('result-unknown', '任务不存在或结果已到期，请核实当前目标。')
    }
    return task
  }

  private running(
    task: TransferTask,
    stage: BatchRunningState['stage'],
    progress?: BatchProgress,
  ): void {
    if (task.state.status !== 'running') {
      return
    }
    if (task.state.stage !== stage) {
      task.stageAt = this.now()
    }
    task.state = {
      ...task.state,
      stage,
      progress: progress ?? task.state.progress,
      updatedAt: this.now(),
    } as BatchRunningState
  }

  private abort(task: TransferTask, reason: KnownOperationError | null): void {
    if (task.state.status !== 'running' || task.controller.signal.aborted) {
      return
    }
    task.reason = reason
    task.state = { ...task.state, cancelRequested: reason === null, updatedAt: this.now() }
    task.controller.abort(
      reason?.code === 'timeout'
        ? new DOMException('任务超时。', 'TimeoutError')
        : new Error('任务中断。'),
    )
    if (task.state.stage === 'ready') {
      task.worker = this.finish(task, reason ? 'failed' : 'cancelled', reason)
    } else if (task.state.stage === 'awaiting-content' && task.receiverRequest) {
      task.worker = this.completeReceiver(task, {
        status: reason ? 'failed' : 'cancelled',
        error: reason,
        results: task.receiverRequest.manifest.files.map((file) => ({
          fileId: file.fileId,
          status: 'not-attempted',
          reason: reason ? 'batch-invalid' : 'cancelled',
        })),
        cleanupError: null,
      })
    }
  }

  private async prepare(task: TransferTask, request: DownloadBatchRequest): Promise<void> {
    try {
      const artifact = await this.archive.prepare(request, {
        signal: task.controller.signal,
        onProgress: (counters) => {
          if (task.state.status === 'running') {
            this.running(task, task.state.stage, {
              ...task.state.progress,
              sourceBytesRead: counters.sourceBytesRead,
            })
          }
        },
      })
      task.artifact = artifact
      if (
        !isBatchManifest(artifact.manifest) ||
        artifact.manifest.transferId !== request.transferId ||
        artifact.manifest.sourceRootId !== request.sourceRootId ||
        artifact.manifest.files.length !== request.files.length ||
        artifact.manifest.files.some(
          (file, index) => file.sourceEntryId !== request.files[index]?.entryId,
        )
      ) {
        throw new HttpOperationError('invalid-archive', '归档清单与当前任务不符。')
      }
      task.manifest = clone(artifact.manifest)
      if (task.controller.signal.aborted) {
        await this.finish(task, task.reason ? 'failed' : 'cancelled', task.reason)
        return
      }
      if (task.state.status === 'running') {
        this.running(task, 'ready', {
          ...task.state.progress,
          sourceBytesRead: artifact.manifest.totalFileBytes,
          totalFileBytes: artifact.manifest.totalFileBytes,
          totalArchiveBytes: artifact.manifest.archive.sizeBytes,
        })
      }
    } catch (error) {
      const cleanup =
        error && typeof error === 'object' && 'cleanupError' in error && error.cleanupError
          ? operation('cleanup-failed', '私有缓存清理失败，请重试。')
          : null
      const wasCancelled =
        task.reason === null &&
        (task.controller.signal.aborted || error instanceof ArchiveCancelledError)
      await this.finish(
        task,
        wasCancelled ? 'cancelled' : 'failed',
        wasCancelled ? null : (task.reason ?? this.knownError(error)),
        cleanup,
      )
    }
  }

  private async send(task: TransferTask, response: ServerResponse): Promise<void> {
    const artifact = task.artifact
    if (!artifact) {
      throw new HttpOperationError('task-conflict', '任务缓存不可用。')
    }
    const descriptor = artifact.manifest.archive
    const hash = createHash('sha256')
    let bytes = 0
    let localFailure: KnownOperationError | null = null
    const rememberFailure = (error: unknown): void => {
      localFailure ??= this.knownError(error)
    }
    let removeErrorListeners = (): void => undefined
    const disconnected = (): void => {
      if (!response.writableFinished) {
        this.abort(task, localFailure ?? operation('network-failure', '归档连接中断。'))
      }
    }
    response.once('close', disconnected)
    try {
      const input = await artifact.openArchive()
      if (task.controller.signal.aborted) {
        input.destroy()
        throw new Error('任务已中断。')
      }
      const counter = new Transform({
        highWaterMark: BATCH_RESOURCES.maxBufferBytes,
        transform: (chunk: Buffer, encoding, callback) => {
          void encoding
          if (!Buffer.isBuffer(chunk) || bytes + chunk.length > descriptor.sizeBytes) {
            callback(new HttpOperationError('checksum-mismatch', '归档发送长度不符。'))
            return
          }
          bytes += chunk.length
          hash.update(chunk)
          task.networkAt = this.now()
          if (task.state.status === 'running') {
            this.running(task, 'transferring', {
              ...task.state.progress,
              archiveBytesTransferred: bytes,
            })
          }
          callback(null, chunk)
        },
        flush: (callback) =>
          callback(
            bytes === descriptor.sizeBytes && hash.digest('hex') === descriptor.sha256
              ? null
              : new HttpOperationError('checksum-mismatch', '归档发送内容不符。'),
          ),
      })
      // 本地流失败会连带关闭响应，必须先保留原错误，避免被 close 误归为网络故障。
      input.once('error', rememberFailure)
      counter.once('error', rememberFailure)
      removeErrorListeners = () => {
        input.off('error', rememberFailure)
        counter.off('error', rememberFailure)
      }
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': descriptor.sizeBytes,
        [HTTP_HEADERS.archiveSha256]: descriptor.sha256,
        'cache-control': 'no-store',
      })
      await pipeline(input, counter, response, { signal: task.controller.signal })
      await this.finish(task, 'sent', null)
    } catch (error) {
      const wasCancelled = task.controller.signal.aborted && task.reason === null
      const failure = task.reason ?? localFailure ?? this.knownError(error)
      await this.finish(task, wasCancelled ? 'cancelled' : 'failed', wasCancelled ? null : failure)
      throw new HttpOperationError(failure.code, failure.message, error)
    } finally {
      removeErrorListeners()
      response.off('close', disconnected)
    }
  }

  private knownError(error: unknown): KnownOperationError {
    const failure = toHttpError(error).operationError
    return failure.code === 'result-unknown'
      ? operation('io-failure', '本地任务处理失败。')
      : failure
  }

  private finish(
    task: TransferTask,
    status: 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    error: OperationError | null,
    previousCleanup: KnownOperationError | null = null,
    results: readonly FileOutcome[] | null = null,
  ): Promise<void> {
    if (task.finishing) {
      return task.finishing
    }
    this.running(task, 'cleaning')
    task.finishing = this.clean(task, status, error, previousCleanup, results)
    return task.finishing
  }

  private async clean(
    task: TransferTask,
    status: 'sent' | 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    error: OperationError | null,
    previousCleanup: KnownOperationError | null,
    results: readonly FileOutcome[] | null,
  ): Promise<void> {
    let cleanupError = previousCleanup
    try {
      await task.artifact?.dispose()
    } catch {
      cleanupError = operation('cleanup-failed', '私有缓存清理失败，请重试。')
    }
    task.artifact = null
    const at = this.now()
    const common = {
      transferId: task.state.transferId,
      direction: task.state.direction,
      role: task.state.role,
      updatedAt: at,
      fileResults: results,
      ...(cleanupError
        ? {
            cleanupStatus: 'incomplete' as const,
            cleanupError: { ...cleanupError, code: 'cleanup-failed' as const },
          }
        : { cleanupStatus: 'complete' as const, cleanupError: null }),
    }
    const terminal = {
      ...common,
      status,
      error:
        status === 'failed'
          ? (error ?? operation('io-failure', '本地任务失败。'))
          : status === 'unknown'
            ? error
            : null,
    }
    if (
      !isBatchState(terminal) ||
      (task.receiverRequest &&
        !matchesBatchState(
          terminal,
          task.receiverRequest.manifest,
          'android-to-windows',
          task.receiverRequest,
        ))
    ) {
      throw new HttpOperationError('result-unknown', '批次最终结果未能对应当前清单。')
    }
    task.state = terminal
    task.terminalAt = at
    if (!cleanupError) {
      this.activeId = null
      if (activeTransferOwner === this.ownership) {
        activeTransferOwner = null
      }
    }
  }

  private completeReceiver(task: TransferTask, completion: ReceiverCompletion): Promise<void> {
    return this.finish(
      task,
      completion.status,
      completion.error,
      completion.cleanupError,
      completion.results,
    )
  }
}
