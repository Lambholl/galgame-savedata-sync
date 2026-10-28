import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BATCH_ARCHIVE,
  BATCH_LIMITS,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  SYNC_LIMITS,
  isSyncJobRequest,
  matchesSyncJobManifest,
  matchesSyncJobState,
  matchesSyncPlan,
} from '@savedata-sync/shared'
import type {
  BatchManifest,
  KnownOperationError,
  OperationError,
  SyncApplyResult,
  SyncJobProgress,
  SyncJobRequest,
  SyncJobState,
  SyncProjectDescriptor,
  SyncWriteOutcome,
} from '@savedata-sync/shared'
import type { WindowsArchive, WindowsArchiveAdapter } from './archive-adapter.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import type { DesktopLibrary } from './library-store.ts'
import type { WindowsSyncScanner } from './sync-scanner.ts'
import type { WindowsSyncMaterial, WindowsSyncWriter } from './sync-writer.ts'
import { ArchiveCancelledError, checkArchiveAbort } from './archive-errors.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { acquireTargetOperation, releaseTargetOperation } from './target-operation.ts'
import { openUploadBody } from './upload-body.ts'

/** 原生依赖固定到当前服务会话；网络不能指定路径、容量策略或执行器。 */
export interface WindowsSyncRegistryOptions {
  readonly archive: Pick<WindowsArchiveAdapter, 'receive' | 'retryCleanup' | 'checkReceiveSpace'>
  readonly writer: WindowsSyncWriter
  readonly backups: WindowsBackupStore
  readonly library: DesktopLibrary
  readonly scanner: WindowsSyncScanner
  readonly deviceId: string
  readonly timeouts?: Partial<{ readonly [Key in keyof typeof BATCH_TIMEOUTS_MS]: number }>
}
interface SyncTask {
  readonly request: SyncJobRequest
  readonly peerId: string
  readonly token: symbol
  readonly acceptedAt: number
  readonly startedAt: number
  readonly controller: AbortController
  state: SyncJobState
  manifest: BatchManifest | null
  artifact: WindowsArchive | null
  worker: Promise<void> | null
  finishing: Promise<void> | null
  reason: KnownOperationError | null
  stageAt: number
  networkAt: number
  terminalAt: number | null
  isManifestClaimed: boolean
  isContentClaimed: boolean
  hasLease: boolean
  isWorking: boolean
}
function cleanupFailure(): KnownOperationError {
  return {
    code: 'cleanup-failed',
    message: '本次归档或写入候选仍待清理，请重试清理。',
    canRetry: false,
  }
}
function known(cause: unknown): KnownOperationError {
  const error = toHttpError(cause).operationError
  return error.code === 'result-unknown'
    ? { code: 'io-failure', message: '接收准备失败。', canRetry: false }
    : error
}
function emptyResult(
  request: SyncJobRequest,
  error: OperationError | null,
  wasCancelled: boolean,
): SyncApplyResult {
  const operations = request.plan.entries.filter(
    (entry) =>
      entry.action === 'create-directory' ||
      entry.action === 'create-file' ||
      entry.action === 'replace-file',
  )
  return {
    schemaVersion: 1,
    planId: request.jobId,
    backupId: null,
    error,
    cleanupError: null,
    outcomes: operations.map((entry, index): SyncWriteOutcome => ({
      path: entry.path,
      action: entry.action as SyncWriteOutcome['action'],
      status: index === 0 ? (wasCancelled ? 'cancelled' : 'failed') : 'not-attempted',
      error: index === 0 ? error : null,
      sizeBytes: null,
      sha256: null,
    })),
  }
}
/**
 * Android 上传的会话内接收编排。先登记确认，再接纳一次清单及一次内容；查询不重放 IO。
 * 全任务借用同一进程名额到写入/缓存清理完毕；停止等待 worker，残留通过 retryCleanup 重试。
 * 已用 ID 保留到会话结束；结果保留十分钟且最多 32 份，不恢复进程重启前任务。
 */
export class WindowsSyncRegistry {
  private readonly options: WindowsSyncRegistryOptions
  private readonly tasks = new Map<string, SyncTask>()
  private readonly usedIds = new Set<string>()
  private readonly timeouts: { [Key in keyof typeof BATCH_TIMEOUTS_MS]: number }
  private readonly timer: ReturnType<typeof setInterval>
  private active: SyncTask | null = null
  private isStopped = false
  constructor(options: WindowsSyncRegistryOptions) {
    this.options = options
    this.timeouts = { ...BATCH_TIMEOUTS_MS, ...options.timeouts }
    for (const key of Object.keys(BATCH_TIMEOUTS_MS) as (keyof typeof BATCH_TIMEOUTS_MS)[]) {
      if (
        !Number.isSafeInteger(this.timeouts[key]) ||
        this.timeouts[key] < 1 ||
        this.timeouts[key] > BATCH_TIMEOUTS_MS[key]
      ) {
        throw new HttpOperationError('invalid-request', '同步任务期限配置无效。')
      }
    }
    this.timer = setInterval(() => this.sweep(), Math.min(1000, ...Object.values(this.timeouts)))
    this.timer.unref()
  }
  /** 只供本机控制查询；其他设备的 HTTP 查询仍须核对任务所有者。 */
  getStates(): readonly SyncJobState[] {
    this.sweep()
    return [...this.tasks.values()].map((task) => structuredClone(task.state))
  }
  /** 活动名额包括失败后的待清理资源，供编辑保护和连接切换检查。 */
  hasWork(): boolean {
    return this.active !== null
  }
  /** 只读目标端设置；先前目录表须有同一项目的双向关联。 */
  async project(projectId: string, peerId: string): Promise<SyncProjectDescriptor> {
    const snapshot = this.options.library.snapshot()
    const game = snapshot.config.games.find((item) => item.id === projectId)
    const link = game?.links.find((item) => item.deviceId === peerId)
    const remoteRoot = snapshot.peers
      .find((item) => item.device.id === peerId)
      ?.games.find((item) => item.id === link?.gameId)?.root
    if (!game?.rootId || !link || !remoteRoot) {
      throw new HttpOperationError('not-found', '项目目录或设备关联不存在。')
    }
    this.options.library.verifyProjectPeer(
      projectId,
      peerId,
      link.gameId,
      game.rootId,
      remoteRoot.rootId,
    )
    const settings = await this.options.backups.settings()
    return {
      schemaVersion: 1,
      projectId,
      deviceId: this.options.deviceId,
      rootId: game.rootId,
      shouldBackup:
        settings.projects.find(
          (item) => item.projectId === projectId && item.rootId === game.rootId,
        )?.shouldBackup ?? true,
    }
  }
  private async verify(task: SyncTask): Promise<void> {
    checkArchiveAbort(task.controller.signal)
    const plan = task.request.plan
    this.options.library.verifyProjectPeer(
      task.request.targetProjectId,
      task.peerId,
      task.request.sourceProjectId,
      plan.target.rootId,
      plan.source.rootId,
    )
    const settings = await this.options.backups.settings()
    const shouldBackup =
      settings.projects.find(
        (item) =>
          item.projectId === task.request.targetProjectId && item.rootId === plan.target.rootId,
      )?.shouldBackup ?? true
    if (shouldBackup !== plan.shouldBackup) {
      throw new HttpOperationError('source-changed', '目标备份设置已变化，请重新确认。')
    }
    checkArchiveAbort(task.controller.signal)
  }
  /** 格式正确后同步占用任务 ID 和名额；已接纳任务的异步错误留在同一任务中查询。 */
  register(value: unknown, peerId: string): Promise<SyncJobState> {
    if (
      !isSyncJobRequest(value) ||
      value.plan.direction !== 'android-to-windows' ||
      value.plan.target.deviceId !== this.options.deviceId ||
      value.plan.source.deviceId !== peerId
    ) {
      throw new HttpOperationError('invalid-request', '复制请求或设备方向无效。')
    }
    this.sweep()
    if (this.isStopped || this.active) {
      throw new HttpOperationError('busy', '已有同步任务或资源等待清理。')
    }
    if (this.usedIds.has(value.jobId)) {
      throw new HttpOperationError('task-conflict', '本次确认已经使用，请查询原任务。')
    }
    if (this.usedIds.size >= BATCH_LIMITS.maxTransfersPerSession) {
      throw new HttpOperationError('resource-limit', '会话任务容量已满。')
    }
    const now = Date.now()
    if (
      value.plan.target.observedAt > now ||
      now - value.plan.target.observedAt > SYNC_LIMITS.snapshotLifetimeMs
    ) {
      throw new HttpOperationError('not-found', '确认扫描已过期，请重新扫描。')
    }
    const cached = this.options.scanner.get(value.plan.target.scanId)
    if (
      cached.status !== 'succeeded' ||
      !cached.snapshot ||
      !matchesSyncPlan(value.plan, {
        planId: value.plan.planId,
        projectId: value.plan.projectId,
        operation: value.plan.operation,
        direction: value.plan.direction,
        shouldBackup: value.plan.shouldBackup,
        source: value.plan.source,
        target: cached.snapshot,
      })
    ) {
      throw new HttpOperationError('invalid-request', '目标扫描与当前会话保存的结果不同。')
    }
    const token = Symbol('sync-job')
    acquireTargetOperation(token)
    const request = structuredClone(value)
    const task: SyncTask = {
      request,
      peerId,
      token,
      acceptedAt: now,
      startedAt: performance.now(),
      controller: new AbortController(),
      manifest: null,
      artifact: null,
      worker: null,
      finishing: null,
      reason: null,
      stageAt: performance.now(),
      networkAt: performance.now(),
      terminalAt: null,
      isManifestClaimed: false,
      isContentClaimed: false,
      hasLease: true,
      isWorking: false,
      state: {
        schemaVersion: 1,
        jobId: request.jobId,
        direction: 'android-to-windows',
        role: 'receiver',
        status: 'running',
        stage: 'preparing',
        updatedAt: now,
        cancelRequested: false,
        result: null,
        error: null,
        cleanupError: null,
        progress: {
          sourceBytesRead: 0,
          archiveBytesTransferred: 0,
          fileBytesVerified: 0,
          fileBytesPublished: 0,
          totalFileBytes: request.plan.totalFileBytes ?? 0,
          totalArchiveBytes: request.plan.transferFileCount === 0 ? 0 : null,
          totalFiles: request.plan.transferFileCount,
          verifiedFiles: 0,
          publishedFiles: 0,
        },
      },
    }
    this.usedIds.add(request.jobId)
    this.tasks.set(request.jobId, task)
    this.active = task
    return this.work(task, () => this.admit(task)).then(() => structuredClone(task.state))
  }
  private work(task: SyncTask, operation: () => Promise<void>): Promise<void> {
    task.isWorking = true
    task.worker = (async (): Promise<void> => {
      try {
        await operation()
      } catch (cause) {
        await this.fail(task, cause)
      } finally {
        if (task.controller.signal.aborted && task.state.status === 'running') {
          await this.fail(task, new ArchiveCancelledError())
        }
        task.isWorking = false
      }
    })()
    return task.worker
  }
  private async admit(task: SyncTask): Promise<void> {
    try {
      await this.verify(task)
      await this.options.writer.checkSpace(task.request.plan)
      await this.verify(task)
      if (task.request.plan.transferFileCount === 0) {
        await this.apply(task)
      }
    } catch (cause) {
      await this.fail(task, cause)
    }
  }
  private require(id: string, peerId: string): SyncTask {
    this.sweep()
    const task = this.tasks.get(id)
    if (!task || task.peerId !== peerId) {
      throw new HttpOperationError('not-found', '本会话没有此同步任务。')
    }
    return task
  }
  /** 独立返回任务 DTO；不把 GET 当作网络内容进展或延长超时。 */
  get(id: string, peerId: string): SyncJobState {
    return structuredClone(this.require(id, peerId).state)
  }
  /** 清单未提交和零文件分支返回 null；和任务结果分开控制 JSON 体积。 */
  manifest(id: string, peerId: string): BatchManifest | null {
    return structuredClone(this.require(id, peerId).manifest)
  }
  /** 一次性提交源清单；容量预检失败也消费本次声明，不自动接受第二次。 */
  async declare(id: string, peerId: string, value: unknown): Promise<SyncJobState> {
    const task = this.require(id, peerId)
    if (
      task.state.status !== 'running' ||
      task.isWorking ||
      task.isManifestClaimed ||
      task.request.plan.transferFileCount === 0
    ) {
      throw new HttpOperationError('task-conflict', '此任务不再接收清单。')
    }
    task.isManifestClaimed = true
    if (!matchesSyncJobManifest(value, task.request) || value === null) {
      const error = new HttpOperationError('invalid-request', '归档清单与确认计划不同。')
      await this.work(task, () => Promise.reject(error))
      throw error
    }
    task.manifest = structuredClone(value)
    this.update(task, 'preparing', { totalArchiveBytes: value.archive.sizeBytes })
    await this.work(task, async (): Promise<void> => {
      try {
        await this.verify(task)
        const space = await this.options.archive.checkReceiveSpace(value)
        await this.options.writer.checkSpace(task.request.plan, space)
        await this.verify(task)
        this.update(task, 'awaiting-content')
      } catch (cause) {
        await this.fail(task, cause)
      }
    })
    return structuredClone(task.state)
  }
  /** 定长 gzip 单次领取；202 只确认完整压缩体，实际写入结果通过原任务查询。 */
  receive(
    id: string,
    peerId: string,
    input: IncomingMessage,
    response: ServerResponse,
  ): Promise<SyncJobState> {
    const task = this.require(id, peerId),
      manifest = task.manifest
    if (
      task.state.status !== 'running' ||
      task.state.stage !== 'awaiting-content' ||
      task.isContentClaimed ||
      !manifest
    ) {
      throw new HttpOperationError('task-conflict', '本次内容已经领取或任务不再等待内容。')
    }
    if (
      input.headers['content-type'] !== BATCH_ARCHIVE.contentType ||
      input.headers['content-length'] !== String(manifest.archive.sizeBytes) ||
      input.headers[HTTP_HEADERS.archiveSha256] !== manifest.archive.sha256
    ) {
      throw new HttpOperationError('invalid-request', '压缩体类型、长度或哈希头与清单不同。')
    }
    task.isContentClaimed = true
    this.update(task, 'transferring')
    task.networkAt = performance.now()
    let resolve: (state: SyncJobState) => void = () => undefined,
      reject: (cause: unknown) => void = () => undefined
    const accepted = new Promise<SyncJobState>((ready, failed) => {
      resolve = ready
      reject = failed
    })
    task.worker = this.work(task, () => this.receiveTask(task, input, response, resolve, reject))
    return accepted
  }
  private async receiveTask(
    task: SyncTask,
    input: IncomingMessage,
    response: ServerResponse,
    accept: (value: SyncJobState) => void,
    reject: (cause: unknown) => void,
  ): Promise<void> {
    const manifest = task.manifest
    if (!manifest) {
      reject(new HttpOperationError('invalid-request', '归档清单缺失。'))
      return
    }
    const body = openUploadBody(input, response, {
      signal: task.controller.signal,
      length: manifest.archive.sizeBytes,
      abort: (reason) => this.abort(task, reason),
      progress: (bytes) => {
        task.networkAt = performance.now()
        this.options.library.touchPeer(task.peerId)
        this.update(task, 'transferring', { archiveBytesTransferred: bytes })
      },
    })
    let hasAccepted = false
    try {
      await this.verify(task)
      task.artifact = await this.options.archive.receive(manifest, body.stream, {
        signal: task.controller.signal,
        onArchiveStored: () => {
          if (!body.isComplete()) {
            throw new HttpOperationError('checksum-mismatch', '上传消息尚未完整结束。')
          }
          this.update(task, 'verifying')
          hasAccepted = true
          accept(structuredClone(task.state))
        },
        onProgress: (progress) => {
          if (task.state.stage === 'verifying') {
            this.update(task, 'verifying', {
              fileBytesVerified: progress.verifiedFileBytes,
              verifiedFiles: progress.verifiedFiles,
            })
          }
        },
      })
      if (!hasAccepted) {
        throw new HttpOperationError('invalid-archive', '接收器未确认压缩体。')
      }
      await this.apply(task)
    } catch (cause) {
      if (!hasAccepted) {
        reject(toHttpError(cause))
      }
      body.close()
      await body.settled
      await this.fail(task, cause)
    } finally {
      body.close()
      await body.settled
    }
  }
  private update(
    task: SyncTask,
    stage: SyncJobState['stage'],
    progress: Partial<SyncJobProgress> = {},
  ): void {
    if (task.state.status !== 'running') {
      return
    }
    if (stage !== task.state.stage) {
      task.stageAt = performance.now()
    }
    task.state = {
      ...task.state,
      stage,
      updatedAt: Date.now(),
      progress: { ...task.state.progress, ...progress },
    }
  }
  private async apply(task: SyncTask): Promise<void> {
    await this.verify(task)
    const artifact = task.artifact
    const material: WindowsSyncMaterial | null = artifact
      ? {
          snapshot: task.request.plan.source,
          openFile: async (entryId) => {
            const file = artifact.manifest.files.find((entry) => entry.sourceEntryId === entryId)
            if (!file) {
              throw new HttpOperationError('invalid-request', '归档缺少本次源文件。')
            }
            return {
              stream: await artifact.openFile(file.fileId),
              verifyUnchanged: () => Promise.resolve(),
            }
          },
        }
      : null
    const result = await this.options.writer.apply(task.request.plan, material, {
      signal: task.controller.signal,
      lease: { token: task.token, acceptedAt: task.acceptedAt },
      verifyContext: () => this.verify(task),
      onStage: (stage) => this.update(task, stage === 'checking' ? 'verifying' : stage),
      onOutcome: (outcome) => {
        if (outcome.status === 'succeeded' && outcome.action !== 'create-directory') {
          this.update(task, 'writing', {
            publishedFiles: task.state.progress.publishedFiles + 1,
            fileBytesPublished: task.state.progress.fileBytesPublished + (outcome.sizeBytes ?? 0),
          })
        }
      },
    })
    // 超时引起的取消有稳定根错误；已经成功或提交结果不确定的写入保留实际观察。
    const hasCancellation = result.outcomes.some((item) => item.status === 'cancelled')
    const hasAllSucceeded =
      result.error === null && result.outcomes.every((item) => item.status === 'succeeded')
    const actual =
      task.reason && !hasAllSucceeded && (hasCancellation || result.error === null)
        ? {
            ...result,
            error: task.reason,
            outcomes: result.outcomes.map((item): SyncWriteOutcome =>
              item.status === 'cancelled'
                ? { ...item, status: 'failed', error: task.reason }
                : item,
            ),
          }
        : result
    await this.finish(
      task,
      actual,
      !task.reason && (hasCancellation || (!hasAllSucceeded && task.controller.signal.aborted)),
    )
  }
  private async fail(task: SyncTask, cause: unknown): Promise<void> {
    if (task.state.status !== 'running') {
      return
    }
    const wasCancelled =
      task.reason === null &&
      (task.controller.signal.aborted || cause instanceof ArchiveCancelledError)
    const result = emptyResult(
      task.request,
      wasCancelled ? null : (task.reason ?? known(cause)),
      wasCancelled,
    )
    await this.finish(task, result, wasCancelled)
  }
  private async finish(
    task: SyncTask,
    result: SyncApplyResult,
    wasCancelled: boolean,
  ): Promise<void> {
    if (task.finishing) {
      return task.finishing
    }
    task.finishing = (async (): Promise<void> => {
      this.update(task, 'cleaning')
      let cleanupError = result.cleanupError
      try {
        await this.clean(task)
      } catch {
        cleanupError = cleanupFailure()
      }
      const hasAllSucceeded =
        result.error === null && result.outcomes.every((item) => item.status === 'succeeded')
      task.state = {
        ...task.state,
        status:
          result.error?.code === 'result-unknown'
            ? 'unknown'
            : result.error
              ? 'failed'
              : wasCancelled && !hasAllSucceeded
                ? 'cancelled'
                : 'succeeded',
        stage: 'done',
        updatedAt: Date.now(),
        result: { ...result, cleanupError },
        error: result.error,
        cleanupError,
      }
      task.terminalAt = performance.now()
      if (!matchesSyncJobState(structuredClone(task.state), task.request, task.manifest)) {
        // 原生结果不满足公开守卫时保留结果，停止接纳；不能把错误包装成成功。
        task.state = {
          ...task.state,
          status: 'unknown',
          error: {
            code: 'result-unknown',
            message: '目标结果无法对应本次确认，请重读目标。',
            canRetry: false,
          },
        }
        task.state = { ...task.state, result: { ...result, cleanupError, error: task.state.error } }
        this.isStopped = true
      }
    })()
    return task.finishing
  }
  private async clean(task: SyncTask): Promise<void> {
    await this.options.writer.retryCleanup()
    if (task.artifact) {
      await task.artifact.dispose()
      task.artifact = null
    }
    await this.options.archive.retryCleanup()
    if (task.hasLease) {
      releaseTargetOperation(task.token)
      task.hasLease = false
    }
    if (this.active === task) {
      this.active = null
    }
  }
  private abort(task: SyncTask, reason: KnownOperationError | null = null): void {
    if (task.state.status !== 'running' || task.controller.signal.aborted) {
      return
    }
    task.reason = reason
    task.state = { ...task.state, cancelRequested: reason === null, updatedAt: Date.now() }
    task.controller.abort()
    if (!task.isWorking) {
      task.worker = this.fail(task, new ArchiveCancelledError())
    }
  }
  /** 显式取消不改写已终止结果；不会撤销前面实际成功的文件。 */
  cancel(id: string, peerId: string): SyncJobState {
    const task = this.require(id, peerId)
    this.abort(task)
    return structuredClone(task.state)
  }
  private sweep(): void {
    const now = performance.now()
    for (const [id, task] of this.tasks) {
      if (task.state.status === 'running') {
        if (
          now - task.startedAt >= this.timeouts.total ||
          (task.state.stage === 'awaiting-content' &&
            now - task.stageAt >= this.timeouts.awaitingContent) ||
          (task.state.stage === 'transferring' && now - task.networkAt >= this.timeouts.networkIdle)
        ) {
          this.abort(task, {
            code: 'timeout',
            message: '同步任务已超过期限，请查询本次结果。',
            canRetry: false,
          })
        }
      } else if (
        !task.hasLease &&
        task.terminalAt !== null &&
        now - task.terminalAt >= this.timeouts.terminalRetention
      ) {
        this.tasks.delete(id)
      }
    }
    while (this.tasks.size > 32) {
      const oldest = [...this.tasks.entries()].find(
        ([, task]) => task.state.status !== 'running' && !task.hasLease,
      )
      if (!oldest) {
        break
      }
      this.tasks.delete(oldest[0])
    }
  }
  /** 只清理本次仍持有的缓存和候选；失败保持名额，不重复覆盖。 */
  async retryCleanup(): Promise<void> {
    const task = this.active
    if (!task) {
      return
    }
    if (task.state.status === 'running') {
      throw new HttpOperationError('busy', '同步任务尚未结束。')
    }
    await this.clean(task)
    task.state = {
      ...task.state,
      cleanupError: null,
      result: task.state.result ? { ...task.state.result, cleanupError: null } : null,
    }
  }
  /** 同步关闭接纳并取消；等待 worker 和清理，失败可再次 stop。 */
  async stop(): Promise<void> {
    this.isStopped = true
    clearInterval(this.timer)
    if (this.active) {
      this.abort(this.active)
    }
    await this.active?.worker
    await this.retryCleanup()
    this.tasks.clear()
  }
}
