import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  BATCH_ARCHIVE,
  BATCH_LIMITS,
  BATCH_RESOURCES,
  BATCH_TIMEOUTS_MS,
  HTTP_HEADERS,
  SYNC_JOB_SCHEMA_VERSION,
  SYNC_LIMITS,
  isSyncJobRequest,
  matchesSyncJobDigest,
  matchesSyncJobManifest,
  matchesSyncJobState,
  matchesSyncPlan,
  observeSyncJob,
  resolveBackupPolicy,
} from '@savedata-sync/shared'
import type {
  BatchManifest,
  KnownOperationError,
  OperationError,
  SyncApplyResult,
  SyncFailureStage,
  SyncJobDigest,
  SyncJobProgress,
  SyncJobRequest,
  SyncJobState,
  SyncProjectDescriptor,
  SyncSnapshot,
  SyncTransferState,
  SyncWriteOutcome,
} from '@savedata-sync/shared'
import type { WindowsArchive, WindowsArchiveAdapter } from './archive-adapter.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import type { ControlHub } from './control-hub.ts'
import type { DesktopLibrary } from './library-store.ts'
import { WindowsSyncScanner } from './sync-scanner.ts'
import type { WindowsScanSource } from './sync-scanner.ts'
import type { WindowsSyncMaterial, WindowsSyncWriter } from './sync-writer.ts'
import { ArchiveCancelledError, checkArchiveAbort } from './archive-errors.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { acquireTargetOperation, releaseTargetOperation } from './target-operation.ts'
import { openUploadBody } from './upload-body.ts'
import type { DesktopCopySummary } from '../bridge/sync-bridge.ts'

/** 原生依赖固定到当前服务会话；网络不能指定路径、容量策略或执行器。 */
export interface WindowsSyncRegistryOptions {
  readonly archive: Pick<
    WindowsArchiveAdapter,
    'prepare' | 'receive' | 'retryCleanup' | 'checkReceiveSpace'
  >
  readonly writer: WindowsSyncWriter
  readonly backups: WindowsBackupStore
  readonly library: DesktopLibrary
  readonly scanner: WindowsSyncScanner
  readonly source: WindowsScanSource
  readonly deviceId: string
  /** 读取对端结果、转发取消；对端的进度摘要由 observe 送入。 */
  readonly control: Pick<ControlHub, 'isOpen' | 'request'>
  readonly timeouts?: Partial<{ readonly [Key in keyof typeof BATCH_TIMEOUTS_MS]: number }>
}
/** 读取对端结果失败后，隔多久再试一次。 */
const REMOTE_READ_RETRY_MS = 5000
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
  /** 对端角色最新的状态；接收端已结束但结果没读到时，保持 running/cleaning。 */
  remote: SyncJobState | null
  /** 读到的 remote 已不可信（断开或读取失败）；新的摘要或结果到达后清除。 */
  remoteError: OperationError | null
  /** 接收端已结束，还需要读取逐项结果。 */
  shouldReadRemote: boolean
  isReadingRemote: boolean
  remoteReadAt: number
  /** 最后一次收到摘要的时间；手机进行中每秒至少推送一次，久未收到就是结果待确认。 */
  remoteSeenAt: number
}
function failureStageOf(stage: SyncJobState['stage']): SyncFailureStage | null {
  return stage === 'cleaning' || stage === 'done' ? null : stage
}
/** 对端还没有最终结论：等它的摘要或结果。接收端自己已结束时，不用等发送端的状态。 */
function isRemoteUnsettled(task: SyncTask): boolean {
  return task.remote
    ? task.remote.status === 'running'
    : task.state.status === 'running' || task.state.status === 'sent'
}
function isRemoteLive(task: SyncTask): boolean {
  return task.remoteError === null && isRemoteUnsettled(task)
}
function cleanupFailure(): KnownOperationError {
  return {
    code: 'cleanup-failed',
    message: 'This archive or write candidate still needs cleanup. Retry cleanup.',
    canRetry: false,
  }
}
function known(cause: unknown): KnownOperationError {
  const error = toHttpError(cause).operationError
  return error.code === 'result-unknown'
    ? { code: 'io-failure', message: 'Receive preparation failed.', canRetry: false }
    : error
}
/** 还没写入就结束时的完整结果：第一项记录原因，其余为未尝试。 */
export function emptyResult(
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
    backupFileCount: null,
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
        throw new HttpOperationError(
          'invalid-request',
          'The sync task deadline configuration is invalid.',
        )
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
  /** 可信本机窗口只轮询摘要；大计划、清单与完整结果按任务分别查询。 */
  summaries(): readonly DesktopCopySummary[] {
    this.sweep()
    return [...this.tasks.values()].map((task) => {
      const { phase, stage, step, percent, hasCleanupError } = observeSyncJob(
        task.state,
        task.remote,
        task.remoteError !== null,
      )
      return {
        jobId: task.request.jobId,
        projectId:
          task.state.role === 'receiver'
            ? task.request.targetProjectId
            : task.request.sourceProjectId,
        peerId: task.peerId,
        direction: task.state.direction,
        role: task.state.role,
        phase,
        stage,
        step,
        percent,
        updatedAt: Math.max(task.state.updatedAt, task.remote?.updatedAt ?? task.state.updatedAt),
        hasCleanupError,
      }
    })
  }
  /** 本机权限由固定 IPC 验证；此入口不接受对端身份或重新登记任务。 */
  localRequest(id: string): SyncJobRequest {
    return structuredClone(this.localTask(id).request)
  }
  /** 两个角色的状态都从这里读；页面重新进入时直接取到当前快照。 */
  localState(id: string): SyncTransferState {
    return this.transferState(this.localTask(id))
  }
  localManifest(id: string): BatchManifest | null {
    return structuredClone(this.localTask(id).manifest)
  }
  /** 当前会话是否有这个任务；还没登记的电脑发起任务由 WindowsRemoteSyncRequests 提供。 */
  has(id: string): boolean {
    return this.tasks.has(id)
  }
  /**
   * 取消一次传输。先让对端知道是用户取消，再断开本机，否则对端会把断流记成网络失败。
   * 本机已结束时对端是唯一还在跑的一方，通知失败就把错误抛给调用者；本机还在跑时照常取消。
   */
  async localCancel(id: string): Promise<SyncTransferState> {
    const task = this.localTask(id)
    const isLocalRunning = task.state.status === 'running'
    if (isRemoteUnsettled(task) && this.options.control.isOpen(task.peerId)) {
      try {
        await this.options.control.request(task.peerId, 'sync.job.cancel', { jobId: id })
      } catch (cause) {
        if (!isLocalRunning) {
          throw cause
        }
      }
    }
    this.abort(task)
    return this.transferState(task)
  }
  /**
   * 收到对端推送的摘要。不属于当前任务的摘要直接忽略：手机发起时可能先于登记到达，
   * 进行中的下一条会补上。接收端结束后才读取一次逐项结果，高频摘要不携带它们。
   */
  observe(peerId: string, digest: SyncJobDigest): void {
    const task = this.tasks.get(digest.jobId)
    if (task?.peerId !== peerId) {
      return
    }
    task.remoteSeenAt = performance.now()
    if (!matchesSyncJobDigest(digest, task.request, task.state.role)) {
      task.remoteError = {
        code: 'result-unknown',
        message: 'The peer reported a state that does not match this task.',
        canRetry: false,
      }
      return
    }
    task.remoteError = null
    const previous = task.remote
    if (digest.role !== 'receiver' || digest.status === 'running') {
      task.remote = { ...digest, result: null }
      this.remoteChanged(task, previous)
    } else if (previous?.result) {
      task.remote = {
        ...previous,
        updatedAt: digest.updatedAt,
        cleanupError: digest.cleanupError,
        result: { ...previous.result, cleanupError: digest.cleanupError },
      }
    } else {
      task.remote = {
        ...digest,
        status: 'running',
        stage: 'cleaning',
        failureStage: null,
        error: null,
        result: null,
      }
      task.shouldReadRemote = true
      this.readRemoteResult(task)
    }
  }
  private transferState(task: SyncTask): SyncTransferState {
    return structuredClone({
      schemaVersion: 1,
      jobId: task.request.jobId,
      local: task.state,
      remote: task.remote,
      remoteError: task.remoteError,
    })
  }
  /** 对端刚结束时重新计算留存期，发送先结束、对端写入很久的任务不会被提前清掉。 */
  private remoteChanged(task: SyncTask, previous: SyncJobState | null): void {
    if (previous?.status === 'running' && task.remote?.status !== 'running' && task.terminalAt) {
      task.terminalAt = performance.now()
    }
  }
  private readRemoteResult(task: SyncTask): void {
    if (task.isReadingRemote) {
      return
    }
    task.isReadingRemote = true
    task.remoteReadAt = performance.now()
    this.options.control
      .request(task.peerId, 'sync.job.read', { jobId: task.request.jobId })
      .then((state) => {
        if (
          state.status === 'running' ||
          state.role === task.state.role ||
          !matchesSyncJobState(
            state,
            task.request,
            state.progress.totalArchiveBytes === null ? null : task.manifest,
          )
        ) {
          throw new HttpOperationError('invalid-request', 'The peer result is invalid.')
        }
        const previous = task.remote
        task.remote = state
        task.remoteError = null
        task.shouldReadRemote = false
        this.remoteChanged(task, previous)
      })
      .catch(() => {
        task.remoteError = {
          code: 'result-unknown',
          message: 'The result from the phone could not be read. It will be read again.',
          canRetry: false,
        }
      })
      .finally(() => {
        task.isReadingRemote = false
      })
  }
  async localCleanup(id: string): Promise<void> {
    const task = this.localTask(id)
    if (task.state.status === 'running' || (this.active !== null && this.active !== task)) {
      throw new HttpOperationError('busy', 'The sync task has not finished.')
    }
    const token = task.hasLease ? null : Symbol('sync-cleanup')
    if (token) {
      acquireTargetOperation(token)
    }
    try {
      if (task.state.role === 'receiver' && task.state.result?.cleanupError) {
        const project = task.request.targetProjectId,
          root = task.request.plan.target.rootId
        if ((await this.options.backups.list(project, root)).incomplete.length > 0) {
          throw new HttpOperationError(
            'cleanup-failed',
            'Inspect and clean up incomplete backups on the backup page first.',
          )
        }
        await this.options.backups.rotate(project, root)
      }
      await this.clean(task)
      task.state = {
        ...task.state,
        updatedAt: Date.now(),
        cleanupError: null,
        result: task.state.result ? { ...task.state.result, cleanupError: null } : null,
      }
    } finally {
      if (token) {
        releaseTargetOperation(token)
      }
    }
  }
  private localTask(id: string): SyncTask {
    this.sweep()
    const task = this.tasks.get(id)
    if (!task) {
      throw new HttpOperationError(
        'not-found',
        'This sync task ended or expired. Read the directory again.',
      )
    }
    return task
  }
  /** 活动名额包括失败后的待清理资源，供编辑保护和连接切换检查。 */
  hasWork(): boolean {
    return this.active !== null
  }
  hasRunningWork(): boolean {
    return [...this.tasks.values()].some(
      (task) => task.isWorking || task.state.status === 'running' || isRemoteLive(task),
    )
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
      throw new HttpOperationError(
        'not-found',
        'The project directory or device link does not exist.',
      )
    }
    this.options.library.verifyProjectPeer(
      projectId,
      peerId,
      link.gameId,
      game.rootId,
      remoteRoot.rootId,
    )
    const settings = await this.options.backups.settings()
    const policy = resolveBackupPolicy(settings, projectId, game.rootId)
    return {
      schemaVersion: 1,
      projectId,
      deviceId: this.options.deviceId,
      rootId: game.rootId,
      shouldBackup: policy.shouldBackup,
      backupKeepCount: policy.keepCount,
    }
  }
  private async verify(task: SyncTask): Promise<void> {
    checkArchiveAbort(task.controller.signal)
    const plan = task.request.plan
    const isSender = task.state.role === 'sender'
    this.options.library.verifyProjectPeer(
      isSender ? task.request.sourceProjectId : task.request.targetProjectId,
      task.peerId,
      isSender ? task.request.targetProjectId : task.request.sourceProjectId,
      isSender ? plan.source.rootId : plan.target.rootId,
      isSender ? plan.target.rootId : plan.source.rootId,
    )
    if (isSender) {
      checkArchiveAbort(task.controller.signal)
      return
    }
    const settings = await this.options.backups.settings()
    const { shouldBackup } = resolveBackupPolicy(
      settings,
      task.request.targetProjectId,
      plan.target.rootId,
    )
    if (shouldBackup !== plan.shouldBackup) {
      throw new HttpOperationError(
        'source-changed',
        'Target backup settings changed. Confirm again.',
      )
    }
    checkArchiveAbort(task.controller.signal)
  }
  /** 格式正确后同步占用任务 ID 和名额；已接纳任务的异步错误留在同一任务中查询。 */
  register(value: unknown, peerId: string): Promise<SyncJobState> {
    const isUpload = isSyncJobRequest(value) && value.plan.direction === 'android-to-windows'
    if (
      !isSyncJobRequest(value) ||
      (isUpload
        ? value.plan.target.deviceId !== this.options.deviceId ||
          value.plan.source.deviceId !== peerId
        : value.plan.source.deviceId !== this.options.deviceId ||
          value.plan.target.deviceId !== peerId)
    ) {
      throw new HttpOperationError(
        'invalid-request',
        'The copy request or device direction is invalid.',
      )
    }
    this.sweep()
    if (this.isStopped || this.active) {
      throw new HttpOperationError('busy', 'A sync task or resources are awaiting cleanup.')
    }
    if (this.usedIds.has(value.jobId)) {
      throw new HttpOperationError(
        'task-conflict',
        'This confirmation was already used. Query the original task.',
      )
    }
    if (this.usedIds.size >= BATCH_LIMITS.maxTransfersPerSession) {
      throw new HttpOperationError('resource-limit', 'The session task capacity is full.')
    }
    const now = Date.now()
    const localSnapshot = isUpload ? value.plan.target : value.plan.source
    if (
      localSnapshot.observedAt > now ||
      now - localSnapshot.observedAt > SYNC_LIMITS.snapshotLifetimeMs
    ) {
      throw new HttpOperationError('not-found', 'The confirmed scan expired. Scan again.')
    }
    const cached = this.options.scanner.get(localSnapshot.scanId)
    if (
      cached.status !== 'succeeded' ||
      !cached.snapshot ||
      !matchesSyncPlan(value.plan, {
        planId: value.plan.planId,
        projectId: value.plan.projectId,
        operation: value.plan.operation,
        direction: value.plan.direction,
        shouldBackup: value.plan.shouldBackup,
        source: isUpload ? value.plan.source : cached.snapshot,
        target: isUpload ? cached.snapshot : value.plan.target,
      })
    ) {
      throw new HttpOperationError(
        'invalid-request',
        'The target scan differs from the result stored in the current session.',
      )
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
      remote: null,
      remoteError: null,
      shouldReadRemote: false,
      isReadingRemote: false,
      remoteReadAt: 0,
      remoteSeenAt: performance.now(),
      state: {
        schemaVersion: SYNC_JOB_SCHEMA_VERSION,
        jobId: request.jobId,
        direction: isUpload ? 'android-to-windows' : 'windows-to-android',
        role: isUpload ? 'receiver' : 'sender',
        status: 'running',
        stage: 'preparing',
        updatedAt: now,
        cancelRequested: false,
        failureStage: null,
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
    if (!isUpload) {
      task.worker = this.work(task, () => this.prepareSource(task))
      return Promise.resolve(structuredClone(task.state))
    }
    return this.work(task, () => this.admit(task)).then(() => structuredClone(task.state))
  }
  private async prepareSource(task: SyncTask): Promise<void> {
    const scanner = new WindowsSyncScanner(this.options.source)
    let scanId: string | null = null
    const abort = (): void => {
      if (scanId !== null) {
        scanner.cancel(scanId)
      }
    }
    try {
      await this.verify(task)
      const scan = scanner.start(task.request.plan.source.rootId)
      scanId = scan.scanId
      task.controller.signal.addEventListener('abort', abort, { once: true })
      if (task.controller.signal.aborted) {
        abort()
      }
      const state = await scanner.wait(scan.scanId)
      checkArchiveAbort(task.controller.signal)
      if (state.status !== 'succeeded' || !state.snapshot) {
        throw new HttpOperationError(
          state.error?.code ?? 'io-failure',
          state.error?.message ?? 'Source directory verification is incomplete.',
        )
      }
      const entries = (snapshot: SyncSnapshot): string =>
        JSON.stringify(
          snapshot.entries.map(({ entryId, path, kind, sizeBytes, modifiedAt, sha256, error }) => ({
            entryId,
            path,
            kind,
            sizeBytes,
            modifiedAt,
            sha256,
            error,
          })),
        )
      if (entries(state.snapshot) !== entries(task.request.plan.source)) {
        throw new HttpOperationError(
          'source-changed',
          'The source directory differs from confirmation. Scan again.',
        )
      }
      if (task.request.plan.transferFileCount === 0) {
        await this.finishSender(task, 'sent', null)
        return
      }
      const files = task.request.plan.entries
        .filter((entry) => entry.action === 'create-file' || entry.action === 'replace-file')
        .map((entry, index) => ({
          fileId: `f${String(index + 1).padStart(6, '0')}`,
          entryId: entry.sourceEntryId,
        }))
      task.artifact = await this.options.archive.prepare(
        {
          protocolVersion: 1,
          transferId: task.request.jobId,
          sourceRootId: task.request.plan.source.rootId,
          files,
        },
        {
          signal: task.controller.signal,
          onProgress: (progress) => {
            if (progress.sourceBytesRead > (task.request.plan.totalFileBytes ?? 0)) {
              throw new HttpOperationError(
                'source-changed',
                'The source file exceeds the confirmed length.',
              )
            }
            this.update(task, 'preparing', { sourceBytesRead: progress.sourceBytesRead })
          },
        },
      )
      if (!matchesSyncJobManifest(task.artifact.manifest, task.request)) {
        throw new HttpOperationError(
          'source-changed',
          'The source archive differs from the confirmed reference, attributes, or content.',
        )
      }
      await this.verify(task)
      task.manifest = task.artifact.manifest
      this.update(task, 'preparing', { totalArchiveBytes: task.manifest.archive.sizeBytes })
    } finally {
      task.controller.signal.removeEventListener('abort', abort)
      await scanner.stop()
    }
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
        if (
          task.state.role === 'sender' &&
          task.state.status === 'running' &&
          task.state.stage === 'preparing' &&
          task.manifest !== null
        ) {
          this.update(task, 'ready')
        }
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
      throw new HttpOperationError(
        'not-found',
        'This sync task does not exist in the current session.',
      )
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
      task.state.role !== 'receiver' ||
      task.isWorking ||
      task.isManifestClaimed ||
      task.request.plan.transferFileCount === 0
    ) {
      throw new HttpOperationError('task-conflict', 'This task no longer accepts a manifest.')
    }
    task.isManifestClaimed = true
    if (!matchesSyncJobManifest(value, task.request) || value === null) {
      const error = new HttpOperationError(
        'invalid-request',
        'The archive manifest differs from the confirmed plan.',
      )
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
      task.state.role !== 'receiver' ||
      task.state.status !== 'running' ||
      task.state.stage !== 'awaiting-content' ||
      task.isContentClaimed ||
      !manifest
    ) {
      throw new HttpOperationError(
        'task-conflict',
        'This content was already claimed or the task is no longer awaiting content.',
      )
    }
    if (
      input.headers['content-type'] !== BATCH_ARCHIVE.contentType ||
      input.headers['content-length'] !== String(manifest.archive.sizeBytes) ||
      input.headers[HTTP_HEADERS.archiveSha256] !== manifest.archive.sha256
    ) {
      throw new HttpOperationError(
        'invalid-request',
        'Compressed content type, length, or hash headers differ from the manifest.',
      )
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
  /** sender ready 的内容只领取一次；sent 只报告本机发送完成，Android 保留独立 receiver 结果。 */
  sendContent(id: string, peerId: string, response: ServerResponse): Promise<void> {
    const task = this.require(id, peerId)
    if (
      task.state.role !== 'sender' ||
      task.state.status !== 'running' ||
      task.state.stage !== 'ready' ||
      task.isWorking ||
      task.isContentClaimed ||
      !task.artifact ||
      !task.manifest
    ) {
      throw new HttpOperationError(
        'task-conflict',
        'This source content is not ready or was already claimed.',
      )
    }
    task.isContentClaimed = true
    this.update(task, 'transferring')
    task.networkAt = performance.now()
    task.worker = this.work(task, () => this.sendSource(task, response))
    return task.worker.then(() => {
      if (task.state.status !== 'sent') {
        throw new HttpOperationError(
          task.state.error?.code ?? 'network-failure',
          task.state.error?.message ?? 'This send operation was aborted. Query the actual status.',
        )
      }
    })
  }
  private async sendSource(task: SyncTask, response: ServerResponse): Promise<void> {
    const artifact = task.artifact,
      manifest = task.manifest
    if (!artifact || !manifest) {
      throw new HttpOperationError('task-conflict', 'The source archive expired.')
    }
    const disconnected = (): void => {
      if (!response.writableFinished) {
        this.abort(task, {
          code: 'network-failure',
          message: 'The sending connection was interrupted before completion.',
          canRetry: false,
        })
      }
    }
    response.once('close', disconnected)
    try {
      await this.verify(task)
      const input = await artifact.openArchive(),
        hash = createHash('sha256')
      let bytes = 0
      const counter = new Transform({
        highWaterMark: BATCH_RESOURCES.maxBufferBytes,
        transform: (chunk: Buffer, encoding, callback) => {
          void encoding
          try {
            if (!Buffer.isBuffer(chunk) || bytes + chunk.length > manifest.archive.sizeBytes) {
              callback(
                new HttpOperationError(
                  'checksum-mismatch',
                  'The source archive exceeds the manifest length.',
                ),
              )
              return
            }
            bytes += chunk.length
            hash.update(chunk)
            task.networkAt = performance.now()
            this.options.library.touchPeer(task.peerId)
            this.update(task, 'transferring', { archiveBytesTransferred: bytes })
            callback(null, chunk)
          } catch (cause) {
            callback(toHttpError(cause))
          }
        },
        flush: (callback) =>
          callback(
            bytes === manifest.archive.sizeBytes && hash.digest('hex') === manifest.archive.sha256
              ? null
              : new HttpOperationError(
                  'checksum-mismatch',
                  'The source archive length or hash differs from the manifest.',
                ),
          ),
      })
      response.writeHead(200, {
        'content-type': BATCH_ARCHIVE.contentType,
        'content-length': manifest.archive.sizeBytes,
        [HTTP_HEADERS.archiveSha256]: manifest.archive.sha256,
        'cache-control': 'no-store',
      })
      await pipeline(input, counter, response, { signal: task.controller.signal })
      await this.finishSender(task, 'sent', null)
    } finally {
      response.off('close', disconnected)
    }
  }
  private async finishSender(
    task: SyncTask,
    status: 'sent' | 'failed' | 'cancelled',
    error: OperationError | null,
  ): Promise<void> {
    if (task.finishing) {
      return task.finishing
    }
    task.finishing = (async (): Promise<void> => {
      // 清理会改写当前阶段，要在这之前记下任务停在哪里。
      const failureStage = status === 'sent' ? null : failureStageOf(task.state.stage)
      this.update(task, 'cleaning')
      let cleanupError: OperationError | null = null
      try {
        await this.clean(task)
      } catch {
        cleanupError = cleanupFailure()
      }
      task.state = {
        ...task.state,
        status,
        stage: 'done',
        failureStage,
        updatedAt: Date.now(),
        result: null,
        error,
        cleanupError,
      }
      task.terminalAt = performance.now()
      if (!matchesSyncJobState(structuredClone(task.state), task.request, task.manifest)) {
        this.isStopped = true
      }
    })()
    return task.finishing
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
      reject(new HttpOperationError('invalid-request', 'The archive manifest is missing.'))
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
            throw new HttpOperationError('checksum-mismatch', 'The upload message is incomplete.')
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
        throw new HttpOperationError(
          'invalid-archive',
          'The receiver did not confirm the compressed content.',
        )
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
              throw new HttpOperationError(
                'invalid-request',
                'The archive is missing a source file for this operation.',
              )
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
    if (task.state.role === 'sender') {
      await this.finishSender(
        task,
        wasCancelled ? 'cancelled' : 'failed',
        wasCancelled ? null : (task.reason ?? known(cause)),
      )
      return
    }
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
      const stoppedAt = failureStageOf(task.state.stage)
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
        failureStage: hasAllSucceeded ? null : stoppedAt,
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
            message:
              'The target result cannot be matched to this confirmation. Read the target again.',
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
      // 控制通道断开或长时间没有摘要时，对端的进度已不可信；手机重连后摘要会清掉这个错误。
      if (
        isRemoteUnsettled(task) &&
        task.remoteError === null &&
        (!this.options.control.isOpen(task.peerId) ||
          now - task.remoteSeenAt >= this.timeouts.networkIdle)
      ) {
        task.remoteError = {
          code: 'result-unknown',
          message: 'The connection to the phone was lost. The result is unconfirmed.',
          canRetry: false,
        }
      }
      if (
        task.shouldReadRemote &&
        now - task.remoteReadAt >= REMOTE_READ_RETRY_MS &&
        this.options.control.isOpen(task.peerId)
      ) {
        this.readRemoteResult(task)
      }
      if (task.state.status === 'running') {
        if (
          now - task.startedAt >= this.timeouts.total ||
          (task.state.stage === 'awaiting-content' &&
            now - task.stageAt >= this.timeouts.awaitingContent) ||
          (task.state.stage === 'ready' && now - task.stageAt >= this.timeouts.ready) ||
          (task.state.stage === 'transferring' && now - task.networkAt >= this.timeouts.networkIdle)
        ) {
          this.abort(task, {
            code: 'timeout',
            message: 'The sync task exceeded its deadline. Query its result.',
            canRetry: false,
          })
        }
      } else if (
        !task.hasLease &&
        !isRemoteLive(task) &&
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
      throw new HttpOperationError('busy', 'The sync task has not finished.')
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
