import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BATCH_ARCHIVE,
  BATCH_LIMITS,
  BATCH_TIMEOUTS_MS,
  SYNC_JOB_SCHEMA_VERSION,
  SYNC_LIMITS,
  isSyncFileWrite,
  isSyncJobRequest,
  isSyncWriteEntry,
  matchesSyncJobDigest,
  matchesSyncJobState,
  matchesSyncPlan,
  observeSyncJob,
  resolveBackupPolicy,
  syncJobBackupBytes,
} from '@savedata-sync/shared'
import type {
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
import type {
  SyncContentFile,
  WindowsArchiveAdapter,
  WindowsStagedFiles,
} from './archive-adapter.ts'
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

/** 复制任务登记表的依赖，固定到当前服务会话。 */
export interface WindowsSyncRegistryOptions {
  readonly archive: Pick<
    WindowsArchiveAdapter,
    'sendFiles' | 'receiveFiles' | 'retryCleanup' | 'checkStagingSpace'
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
  /** 计划里要传的文件，按 tar 成员的顺序。 */
  readonly files: readonly SyncContentFile[]
  staged: WindowsStagedFiles | null
  /** 接收端的内容全部解包后完成，失败或取消时拒绝。 */
  readonly content: Promise<void>
  settleContent: (cause?: unknown) => void
  /** 接收端开始等内容的时间；领取内容后为 null。 */
  awaitingSince: number | null
  isContentReceived: boolean
  isBackupDone: boolean
  /** 接收内容的过程，内容收完或失败后完成；还没领取内容时为 null。 */
  receiving: Promise<void> | null
  worker: Promise<void> | null
  finishing: Promise<void> | null
  reason: KnownOperationError | null
  stageAt: number
  networkAt: number
  terminalAt: number | null
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
  /** 最后一次收到摘要的时间；移动端进行中每秒至少推送一次，久未收到就是结果待确认。 */
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
/** 计划里要传的文件，按写入操作的顺序编号为 tar 成员 f000001、f000002……。 */
function contentFiles(request: SyncJobRequest): readonly SyncContentFile[] {
  const source = new Map(request.plan.source.entries.map((entry) => [entry.entryId, entry]))
  return request.plan.entries
    .filter((entry) => isSyncFileWrite(entry.action))
    .map((entry, index) => {
      const file = entry.sourceEntryId === null ? undefined : source.get(entry.sourceEntryId)
      if (!file || file.sizeBytes === null) {
        throw new HttpOperationError('invalid-request', 'The plan is missing a source file.')
      }
      return {
        fileId: `f${String(index + 1).padStart(6, '0')}`,
        entryId: file.entryId,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
      }
    })
}
/** 还没写入就结束时的完整结果：第一项记录原因，其余为未尝试。 */
export function emptyResult(
  request: SyncJobRequest,
  error: OperationError | null,
  wasCancelled: boolean,
): SyncApplyResult {
  const operations = request.plan.entries.filter(isSyncWriteEntry)
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
    })),
  }
}
/**
 * 当前服务会话内由移动端登记的复制任务，本机可以是接收端或发送端。
 * 本机接收时接受一次内容，边收边解包到私有缓存，收齐后写入目录；本机发送时核对来源，内容只能读取一次，边读边打包发送。
 * 任务从登记到写入和缓存清理结束一直占用写入名额。
 * 用过的任务 ID 保留到会话结束；结果保留 10 分钟，最多 32 份，只存在内存中。
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
  /** 返回所有任务的状态，不核对任务所有者。 */
  getStates(): readonly SyncJobState[] {
    this.sweep()
    return [...this.tasks.values()].map((task) => structuredClone(task.state))
  }
  /** 返回所有任务的摘要。 */
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
        isAwaitingPeer: false,
      }
    })
  }
  /** 返回任务的登记请求，不核对任务所有者；任务不存在时抛出 not-found 错误。 */
  localRequest(id: string): SyncJobRequest {
    return structuredClone(this.localTask(id).request)
  }
  /** 返回任务两个角色的状态，不核对任务所有者；任务不存在时抛出 not-found 错误。 */
  localState(id: string): SyncTransferState {
    return this.transferState(this.localTask(id))
  }
  /** 判断当前会话是否登记了这个任务。 */
  has(id: string): boolean {
    return this.tasks.has(id)
  }
  /**
   * 取消任务，先通知对端再取消本机这一端。
   *
   * @throws HttpOperationError 本机这一端已结束且通知对端失败时抛出。
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
   * 应用对端推送的任务摘要，不属于已登记任务的摘要忽略；对端作为接收端结束后读取一次逐项结果。
   * 本机作为接收端还没收到内容时，发送端报告失败或取消，本机任务随之取消。
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
      // 发送端在交出内容前就结束了，内容不会再来；和收到它的取消请求一样处理，不等总期限。
      if (
        task.state.role === 'receiver' &&
        !task.isContentClaimed &&
        (digest.status === 'failed' || digest.status === 'cancelled')
      ) {
        this.abort(task)
      }
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
          !matchesSyncJobState(state, task.request)
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
          message: 'The result from the mobile device could not be read. It will be read again.',
          canRetry: false,
        }
      })
      .finally(() => {
        task.isReadingRemote = false
      })
  }
  /**
   * 重试任务的缓存清理；本机作为接收端且旧备份轮换失败过时，同时重试轮换。
   *
   * @throws HttpOperationError 任务还在运行或其他任务占着名额时抛出 busy，有残留备份时抛出 cleanup-failed。
   */
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
        const project = task.request.targetProjectId
        if ((await this.options.backups.list(project)).incomplete.length > 0) {
          throw new HttpOperationError(
            'cleanup-failed',
            'Inspect and clean up incomplete backups on the backup page first.',
          )
        }
        await this.options.backups.rotate(project)
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
  /** 判断是否有任务占着写入名额，包括清理失败后待清理的任务。 */
  hasWork(): boolean {
    return this.active !== null
  }
  /** 判断是否有任务正在运行，包括对端还在执行的任务。 */
  hasRunningWork(): boolean {
    return [...this.tasks.values()].some(
      (task) => task.isWorking || task.state.status === 'running' || isRemoteLive(task),
    )
  }
  /** 返回本机项目的描述和备份设置；之前交换的目录表里没有这个项目与 peerId 的双向关联时抛错。 */
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
    const policy = resolveBackupPolicy(settings, projectId)
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
    const { shouldBackup } = resolveBackupPolicy(settings, task.request.targetProjectId)
    if (shouldBackup !== plan.shouldBackup) {
      throw new HttpOperationError(
        'source-changed',
        'Target backup settings changed. Confirm again.',
      )
    }
    checkArchiveAbort(task.controller.signal)
  }
  /** 登记任务：格式正确后同步占用任务 ID 和名额；之后的异步错误记在任务状态里。 */
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
        shouldDeleteExtras: value.plan.shouldDeleteExtras,
        source: isUpload ? value.plan.source : cached.snapshot,
        target: isUpload ? cached.snapshot : value.plan.target,
      })
    ) {
      throw new HttpOperationError(
        'invalid-request',
        'The target scan differs from the result stored in the current session.',
      )
    }
    const request = structuredClone(value)
    const files = contentFiles(request)
    const token = Symbol('sync-job')
    acquireTargetOperation(token)
    let settleContent: (cause?: unknown) => void = () => undefined
    const content = new Promise<void>((resolve, reject) => {
      settleContent = (cause) => {
        if (cause === undefined) {
          resolve()
        } else {
          reject(cause instanceof Error ? cause : new Error('Receiving the content failed.'))
        }
      }
    })
    // 内容可能在写入器等它之前就失败，先挂上处理，避免成为未处理的拒绝。
    content.catch(() => undefined)
    const task: SyncTask = {
      request,
      peerId,
      token,
      acceptedAt: now,
      startedAt: performance.now(),
      controller: new AbortController(),
      files,
      staged: null,
      content,
      settleContent,
      awaitingSince: null,
      isContentReceived: false,
      isBackupDone: false,
      receiving: null,
      worker: null,
      finishing: null,
      reason: null,
      stageAt: performance.now(),
      networkAt: performance.now(),
      terminalAt: null,
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
          transferredBytes: 0,
          totalFileBytes: request.plan.totalFileBytes ?? 0,
          totalFiles: request.plan.transferFileCount,
          publishedFiles: 0,
          fileBytesPublished: 0,
          backupBytesCopied: 0,
          totalBackupBytes: syncJobBackupBytes(request.plan),
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
    return this.work(task, () => this.admit(task)).then(() => {
      // 通过容量核对后立即开始备份，同时等发送端上传内容。
      if (task.state.status === 'running' && request.plan.transferFileCount > 0) {
        task.awaitingSince = performance.now()
        task.worker = this.work(task, () => this.apply(task))
      }
      return structuredClone(task.state)
    })
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
          snapshot.entries.map(({ entryId, path, kind, sizeBytes, modifiedAt, error }) => ({
            entryId,
            path,
            kind,
            sizeBytes,
            modifiedAt,
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
      this.update(task, 'ready')
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
      }
    })()
    return task.worker
  }
  private async admit(task: SyncTask): Promise<void> {
    try {
      await this.verify(task)
      const space = await this.options.archive.checkStagingSpace(
        task.request.plan.totalFileBytes ?? 0,
      )
      await this.options.writer.checkSpace(task.request.plan, space)
      await this.verify(task)
      if (task.request.plan.transferFileCount === 0) {
        await this.apply(task)
      } else {
        this.update(task, 'backing-up')
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
  /** 返回任务状态；这次读取不算网络进展，也不延长超时。 */
  get(id: string, peerId: string): SyncJobState {
    return structuredClone(this.require(id, peerId).state)
  }
  /**
   * 接收 tar.gz 内容，每个任务只能领取一次，备份期间也可以开始；边收边解包，响应 202 表示内容已完整解包，
   * 写入结果在任务状态里。
   */
  receive(
    id: string,
    peerId: string,
    input: IncomingMessage,
    response: ServerResponse,
  ): Promise<SyncJobState> {
    const task = this.require(id, peerId)
    if (
      task.state.role !== 'receiver' ||
      task.state.status !== 'running' ||
      task.awaitingSince === null ||
      task.isContentClaimed
    ) {
      throw new HttpOperationError(
        'task-conflict',
        'This content was already claimed or the task is no longer awaiting content.',
      )
    }
    if (input.headers['content-type'] !== BATCH_ARCHIVE.contentType) {
      throw new HttpOperationError('invalid-request', 'The content type is not gzip.')
    }
    task.isContentClaimed = true
    task.awaitingSince = null
    this.update(task, this.contentStage(task))
    task.networkAt = performance.now()
    return new Promise<SyncJobState>((resolve, reject) => {
      task.receiving = this.receiveTask(task, input, response, resolve, reject)
    })
  }
  /** 备份完成前是备份阶段，之后按内容的进展是等待内容、传输或写入。 */
  private contentStage(task: SyncTask): SyncJobState['stage'] {
    if (!task.isBackupDone) {
      return 'backing-up'
    }
    if (task.isContentReceived) {
      return 'writing'
    }
    return task.isContentClaimed ? 'transferring' : 'awaiting-content'
  }
  /** 边读来源边打包发送，每个任务只能领取一次；状态 sent 只表示本机发送完成。 */
  sendContent(id: string, peerId: string, response: ServerResponse): Promise<void> {
    const task = this.require(id, peerId)
    if (
      task.state.role !== 'sender' ||
      task.state.status !== 'running' ||
      task.state.stage !== 'ready' ||
      task.isWorking ||
      task.isContentClaimed
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
      // 长度事先不知道，响应按 chunked 发送；完整性由 gzip 的 CRC 和长度保证。
      response.writeHead(200, {
        'content-type': BATCH_ARCHIVE.contentType,
        'cache-control': 'no-store',
      })
      await this.options.archive.sendFiles(task.request.plan.source.rootId, task.files, response, {
        signal: task.controller.signal,
        onBytes: (bytes) => {
          task.networkAt = performance.now()
          this.options.library.touchPeer(task.peerId)
          this.update(task, 'transferring', { transferredBytes: bytes })
        },
      })
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
      if (!matchesSyncJobState(structuredClone(task.state), task.request)) {
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
    const body = openUploadBody(input, response, {
      signal: task.controller.signal,
      maxBytes: BATCH_LIMITS.maxArchiveBytes,
      abort: (reason) => this.abort(task, reason),
      progress: () => {
        task.networkAt = performance.now()
        this.options.library.touchPeer(task.peerId)
      },
    })
    try {
      await this.verify(task)
      task.staged = await this.options.archive.receiveFiles(task.files, body.stream, {
        signal: task.controller.signal,
        onBytes: (bytes) => this.update(task, this.contentStage(task), { transferredBytes: bytes }),
      })
      if (!body.isComplete()) {
        throw new HttpOperationError('checksum-mismatch', 'The upload message is incomplete.')
      }
      task.isContentReceived = true
      this.update(task, this.contentStage(task))
      task.settleContent()
      accept(structuredClone(task.state))
    } catch (cause) {
      // 任务被取消、超时或写入器先失败时接收被中止。回给发送端的是任务的原因或 task-conflict，发送端再按任务状态里的结果结束。
      reject(
        task.controller.signal.aborted
          ? new HttpOperationError(
              task.reason?.code ?? 'task-conflict',
              task.reason?.message ?? 'The task was cancelled or has ended. Query its result.',
            )
          : toHttpError(cause),
      )
      body.close()
      await body.settled
      // 写入器可能还在备份，中止它，任务按内容的错误结束。
      this.abort(task, known(cause))
      task.settleContent(cause)
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
    const material: WindowsSyncMaterial | null =
      task.request.plan.transferFileCount > 0
        ? {
            snapshot: task.request.plan.source,
            openFile: async (entryId) => {
              const file = task.files.find((entry) => entry.entryId === entryId)
              if (!file || !task.staged) {
                throw new HttpOperationError(
                  'invalid-request',
                  'The content is missing a source file for this operation.',
                )
              }
              return {
                stream: await task.staged.openFile(file.fileId),
                verifyUnchanged: () => Promise.resolve(),
              }
            },
            ready: () => {
              task.isBackupDone = true
              this.update(task, this.contentStage(task))
              return task.content
            },
          }
        : null
    const result = await this.options.writer.apply(task.request.plan, material, {
      signal: task.controller.signal,
      lease: { token: task.token, acceptedAt: task.acceptedAt },
      verifyContext: () => this.verify(task),
      // 写入前核对目标是备份的一部分，备份要按核对过的目录复制。
      onStage: (stage) =>
        this.update(task, stage === 'writing' ? 'writing' : this.contentStage(task)),
      onBackupProgress: (bytesCopied) => {
        this.update(task, this.contentStage(task), { backupBytesCopied: bytesCopied })
      },
      onOutcome: (outcome) => {
        if (outcome.status === 'succeeded' && isSyncFileWrite(outcome.action)) {
          this.update(task, 'writing', {
            publishedFiles: task.state.progress.publishedFiles + 1,
            fileBytesPublished: task.state.progress.fileBytesPublished + (outcome.sizeBytes ?? 0),
          })
        }
      },
    })
    // 超时引起的取消有稳定的根错误；已成功或提交结果不确定的写入，保留实际观察到的结果。
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
      // 写入器先失败时内容可能还在接收，停下它再清理缓存。
      if (task.receiving && !task.isContentReceived) {
        task.controller.abort()
      }
      await task.receiving
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
      if (!matchesSyncJobState(structuredClone(task.state), task.request)) {
        // 结果不符合公开校验时保留结果并停止接受任务，不能把这个错误当成成功。
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
    if (task.staged) {
      await task.staged.dispose()
      task.staged = null
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
    task.settleContent(new ArchiveCancelledError())
    if (!task.isWorking) {
      task.worker = this.fail(task, new ArchiveCancelledError())
    }
  }
  /** 取消任务。已结束的结果不会被改写，前面已成功的文件不会被撤销。 */
  cancel(id: string, peerId: string): SyncJobState {
    const task = this.require(id, peerId)
    this.abort(task)
    return structuredClone(task.state)
  }
  private sweep(): void {
    const now = performance.now()
    for (const [id, task] of this.tasks) {
      // 控制通道断开或长时间没有摘要时，对端的进度已不可信；移动端重连后摘要会清掉这个错误。
      if (
        isRemoteUnsettled(task) &&
        task.remoteError === null &&
        (!this.options.control.isOpen(task.peerId) ||
          now - task.remoteSeenAt >= this.timeouts.networkIdle)
      ) {
        task.remoteError = {
          code: 'result-unknown',
          message: 'The connection to the mobile device was lost. The result is unconfirmed.',
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
          (task.awaitingSince !== null &&
            now - task.awaitingSince >= this.timeouts.awaitingContent) ||
          (task.state.stage === 'ready' && now - task.stageAt >= this.timeouts.ready) ||
          ((task.state.stage === 'transferring' ||
            (task.isContentClaimed && !task.isContentReceived)) &&
            now - task.networkAt >= this.timeouts.networkIdle) ||
          // 发送端打包期间每秒推送摘要；这么久没收到，说明它已经不在，清单和内容都等不到。
          (task.state.role === 'receiver' &&
            task.state.stage === 'preparing' &&
            now - task.remoteSeenAt >= this.timeouts.networkIdle)
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
  /** 重试清理当前仍持有的缓存和候选文件；失败时继续占名额。 */
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
  /** 停止接受任务并取消进行中的任务，等待它们结束和清理；失败后可以再次 stop。 */
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
