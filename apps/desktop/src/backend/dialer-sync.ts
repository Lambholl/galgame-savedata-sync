import { randomUUID } from 'node:crypto'
import {
  BATCH_LIMITS,
  BATCH_TIMEOUTS_MS,
  SYNC_CAPABILITIES_VERSION,
  SYNC_HTTP_ROUTES,
  SYNC_JOB_SCHEMA_VERSION,
  SYNC_LIMITS,
  createSyncPlan,
  isSyncCapabilities,
  isSyncFileWrite,
  isSyncProjectDescriptor,
  isSyncScanState,
  matchesSyncJobState,
  observeSyncJob,
  syncJobBackupBytes,
  withSyncPlanChoices,
} from '@savedata-sync/shared'
import type {
  ControlRequestBodies,
  ControlResponseValues,
  ErrorDevice,
  KnownOperationError,
  OperationError,
  OperationErrorCode,
  RemoteSyncReport,
  SyncApplyResult,
  SyncDirection,
  SyncJobDigest,
  SyncJobProgress,
  SyncJobRequest,
  SyncJobState,
  SyncPlan,
  SyncPlanChoices,
  SyncScanState,
  SyncSnapshot,
  SyncTransferState,
  SyncWriteOutcome,
} from '@savedata-sync/shared'
import type { DesktopCopySummary, DesktopRemoteRequest } from '../bridge/sync-bridge.ts'
import type {
  SyncContentFile,
  DesktopArchiveAdapter,
  DesktopStagedFiles,
} from './archive-adapter.ts'
import { ArchiveCancelledError, ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import type {
  DialerConnection,
  DialerSyncHandler,
  DialerSyncMethod,
  DialerSyncRequest,
  DesktopDialer,
} from './dialer-session.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { DesktopLibrary } from './library-store.ts'
import { contentFiles, emptyResult } from './sync-registry.ts'
import type { DesktopSyncScanner } from './sync-scanner.ts'
import type {
  DesktopSyncMaterial,
  DesktopSyncWriteOptions,
  DesktopSyncWriter,
} from './sync-writer.ts'
import { acquireTargetOperation, releaseTargetOperation } from './target-operation.ts'

/** 结束的准备和任务保留多久。 */
const RETENTION_MS = BATCH_TIMEOUTS_MS.terminalRetention
/** 准备和任务各最多保留几份。 */
const MAX_RETAINED = 32
/** 进行中的任务没有变化时，摘要至少多久推送一次。 */
const REPORT_INTERVAL_MS = 1000
/** 检查摘要变化的周期；对方的传输详情最多落后这么久。 */
const REPORT_CHECK_MS = 200
/** 轮询对方扫描和任务状态的间隔。 */
const POLL_MS = 100
/** 上传连接断开后等监听方自己结束的最长时间。 */
const UPLOAD_SETTLE_MS = 5000
/** 取消、补读结果这类收尾请求的期限。 */
const SHORT_TIMEOUT_MS = 5000
/** 监听方正忙于另一个扫描时，重试开始扫描的时长。 */
const SCAN_BUSY_WAIT_MS = 5000
/** 监听方发起时，本机任务刚结束的等待时长；任务条的轮询还没跟上时不报 busy。 */
const PREPARE_SETTLE_MS = 2000
/** 本机写入期间读一次对方任务状态的间隔，让对方记录在线时间。 */
const HEARTBEAT_MS = 3000
/** 本机上传时，对方仍在备份时刷新它进度的间隔。 */
const UPLOAD_TARGET_REFRESH_MS = 1000
/** 结果待确认后再次补读的最短间隔。 */
const RECOVER_INTERVAL_MS = 5000

// 和 shared locateSyncError、Android SyncTransferEngine 的清单相同，三处要一起改。
/** 能归到某一端的错误码，都是文件和目录访问失败。 */
const DEVICE_ERRORS: ReadonlySet<OperationErrorCode> = new Set<OperationErrorCode>([
  'authorization-expired',
  'permission-denied',
  'not-found',
  'not-readable',
  'unsupported-operation',
  'name-conflict',
  'path-outside-root',
  'insufficient-space',
  'io-failure',
])

/** 拨号方传输引擎的依赖。 */
export interface DesktopDialerSyncOptions {
  readonly dialer: Pick<
    DesktopDialer,
    'deviceId' | 'isOpen' | 'connection' | 'verify' | 'refreshCatalog' | 'emit'
  >
  readonly library: Pick<DesktopLibrary, 'snapshot' | 'verifyProjectPeer'>
  /** 本机目录的扫描器，只供本引擎使用。 */
  readonly scanner: DesktopSyncScanner
  readonly archive: Pick<
    DesktopArchiveAdapter,
    'sendFiles' | 'receiveFiles' | 'retryCleanup' | 'checkStagingSpace'
  >
  readonly writer: Pick<DesktopSyncWriter, 'apply' | 'checkSpace' | 'retryCleanup'>
  readonly deviceId: string
}

interface Preparation {
  /** 同时是计划 ID、任务 ID，以及本机发起时界面上的请求 ID。 */
  readonly id: string
  readonly peerId: string
  /** 本机游戏 ID。 */
  readonly projectId: string
  readonly remoteProjectId: string
  readonly localRootId: string
  readonly remoteRootId: string
  readonly direction: SyncDirection
  readonly connection: DialerConnection
  readonly controller: AbortController
  /** 监听方发起时它的请求 ID；本机发起时为 null。 */
  readonly listenerRequestId: string | null
  status: 'preparing' | 'ready' | 'failed' | 'cancelled'
  /** 准备好的计划，shouldBackup 和 shouldDeleteExtras 都为 false；确认后换成确认的计划，取消后为 null。 */
  plan: SyncPlan | null
  error: OperationError | null
  remoteScanId: string | null
  wasCancelRequested: boolean
  hasTimedOut: boolean
  isConsumed: boolean
  startedAt: number
  settledAt: number | null
  updatedAt: number
}

interface Job {
  readonly preparation: Preparation
  readonly request: SyncJobRequest
  readonly files: readonly SyncContentFile[]
  readonly token: symbol
  readonly acceptedAt: number
  readonly startedAt: number
  readonly controller: AbortController
  state: SyncJobState
  remote: SyncJobState | null
  remoteError: OperationError | null
  staged: DesktopStagedFiles | null
  /** 接收的内容全部解包后完成，失败时带着原因拒绝。 */
  readonly content: Promise<void>
  settleContent: (cause?: unknown) => void
  isRunning: boolean
  hasLease: boolean
  hasTimedOut: boolean
  wasRemoteAttempted: boolean
  wasCancelSent: boolean
  isUploading: boolean
  isUploadComplete: boolean
  isBackupDone: boolean
  isContentClaimed: boolean
  isContentReceived: boolean
  /** 内容已收齐、本机在写入；期间定时读对方状态作心跳。 */
  isWriting: boolean
  endedAt: number | null
  /** 最后一次发送成功的摘要；只在发送成功后更新，断开期间的变化重连后补发。 */
  reported: string | null
  reportedAt: number
  recovering: Promise<void> | null
  recoveredAt: number
  worker: Promise<void> | null
}

function isDialerSending(direction: SyncDirection): boolean {
  return direction === 'dialer-to-listener'
}

/** 任务状态去掉逐项结果后的摘要。 */
function digestOf(state: SyncJobState): SyncJobDigest {
  return {
    schemaVersion: state.schemaVersion,
    jobId: state.jobId,
    direction: state.direction,
    role: state.role,
    status: state.status,
    stage: state.stage,
    updatedAt: state.updatedAt,
    isCancelRequested: state.isCancelRequested,
    progress: state.progress,
    failureStage: state.failureStage,
    error: state.error,
    cleanupError: state.cleanupError,
  }
}

function failureStageOf(stage: SyncJobState['stage']): SyncJobState['failureStage'] {
  return stage === 'cleaning' || stage === 'done' ? null : stage
}

/** 把错误转成可以写进任务状态的错误；结果待确认在开始写入前不会出现，改记为读写失败。 */
function knownError(cause: unknown): KnownOperationError {
  const error = toHttpError(cause).operationError
  return error.code === 'result-unknown' || error.code === 'session-mismatch'
    ? {
        code: error.code === 'session-mismatch' ? 'network-failure' : 'io-failure',
        message: error.message,
        canRetry: false,
      }
    : error
}

function withDevice(error: OperationError, device: ErrorDevice | null): OperationError {
  return device !== null && error.device === undefined && DEVICE_ERRORS.has(error.code)
    ? { ...error, device }
    : error
}

function cleanupFailure(): KnownOperationError {
  return {
    code: 'cleanup-failed',
    message: 'This archive or write candidate still needs cleanup. Retry cleanup.',
    canRetry: false,
  }
}

function resultUnknown(message: string): OperationError {
  return { code: 'result-unknown', message, canRetry: false }
}

/** 等 ms 毫秒；signal 中断时提前结束并抛出中断的错误。 */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
  checkArchiveAbort(signal)
}

function route(template: string, key: string, value: string): string {
  return template.replace(`{${key}}`, encodeURIComponent(value))
}

/**
 * 本机作为拨号方的复制：扫描两端、生成计划、在监听方登记任务、上传或下载内容并读取结果。
 * 本机和监听方都可以发起；监听方发起时经控制通道请求本机扫描和执行。
 * 准备和任务只存在内存中，结束后保留 RETENTION_MS、各最多 MAX_RETAINED 份；任务从确认到清理结束占用写入名额。
 */
export class DesktopDialerSync implements DialerSyncHandler {
  private readonly options: DesktopDialerSyncOptions
  private readonly preparations = new Map<string, Preparation>()
  private readonly jobs = new Map<string, Job>()
  private readonly usedIds = new Set<string>()
  private readonly timer: ReturnType<typeof setInterval>
  private preparing: Preparation | null = null
  /** 本机界面发起的最近一次准备。 */
  private shown: Preparation | null = null
  private active: Job | null = null
  /** 监听方最近一次发起的请求 ID；它取消后为 null。 */
  private latestListenerRequestId: string | null = null
  private isStopped = false
  /** 写入期间上一次读监听方状态的时刻。 */
  private lastHeartbeat = 0

  constructor(options: DesktopDialerSyncOptions) {
    this.options = options
    this.timer = setInterval(() => this.tick(), REPORT_CHECK_MS)
    this.timer.unref()
  }

  // ---------- 本机界面 ----------

  /** 本机界面发起的最近一次请求；没有时为 null。 */
  currentRequest(): DesktopRemoteRequest | null {
    this.purge()
    return this.shown ? this.describe(this.shown) : null
  }

  /** 判断 peerId 是否是本机拨号连接的设备，包括正在重连的。 */
  isPeer(peerId: string): boolean {
    return this.options.dialer.deviceId() === peerId
  }

  /** 判断 requestId 是否是本机界面发起的请求。 */
  ownsRequest(requestId: string): boolean {
    return this.shown?.id === requestId
  }

  /**
   * 扫描本机和连着的监听方，生成复制计划；立即返回，计划随后从 request 读取。
   * 还没结束的准备被取代并取消。
   *
   * @throws HttpOperationError 有任务在运行时抛 busy；游戏没设目录、没关联这台设备或设备不在线时抛出相应错误。
   */
  start(projectId: string, peerId: string, direction: SyncDirection): DesktopRemoteRequest {
    this.available()
    if (this.active?.isRunning) {
      throw new HttpOperationError(
        'busy',
        'A transfer is still running. Wait for it to finish before starting another.',
      )
    }
    const preparation = this.prepare(projectId, peerId, direction, null)
    this.shown = preparation
    return this.describe(preparation)
  }

  /**
   * 读取本机发起的请求的计划。
   *
   * @throws HttpOperationError 请求不存在或还没准备好时抛 not-found。
   */
  plan(requestId: string): SyncPlan {
    const preparation = this.shownPreparation(requestId)
    if (!preparation.plan) {
      throw new HttpOperationError('not-found', 'This plan is not ready yet.')
    }
    return structuredClone(preparation.plan)
  }

  /**
   * 确认本机发起的请求的计划并开始执行；计划按 choices 重新生成。
   *
   * @throws HttpOperationError 计划不能执行、已过期（plan-expired）或有任务占着写入名额（busy）时抛出。
   */
  confirm(requestId: string, choices: SyncPlanChoices): DesktopRemoteRequest {
    const preparation = this.shownPreparation(requestId)
    this.execute(preparation, choices)
    return this.describe(preparation)
  }

  /**
   * 取消本机发起、还没确认的请求。
   *
   * @throws HttpOperationError 请求不存在时抛 not-found，已经开始执行时抛 busy。
   */
  cancel(requestId: string): DesktopRemoteRequest {
    const preparation = this.shownPreparation(requestId)
    if (preparation.isConsumed) {
      throw new HttpOperationError(
        'busy',
        'The transfer has already started. Cancel it from the task list.',
      )
    }
    this.cancelPreparation(preparation)
    return this.describe(preparation)
  }

  /** 所有任务的摘要。 */
  summaries(): readonly DesktopCopySummary[] {
    this.purge()
    return [...this.jobs.values()].map((job) => {
      const { phase, stage, step, percent, hasCleanupError } = observeSyncJob(
        job.state,
        job.remote,
        job.remoteError !== null,
      )
      return {
        jobId: job.request.jobId,
        projectId: job.preparation.projectId,
        peerId: job.preparation.peerId,
        direction: job.state.direction,
        role: job.state.role,
        localSide: 'dialer',
        phase,
        stage,
        step,
        percent,
        updatedAt: Math.max(job.state.updatedAt, job.remote?.updatedAt ?? 0),
        hasCleanupError,
        isAwaitingPeer: false,
        isPeerInitiated: job.preparation.listenerRequestId !== null,
        shouldBackup: job.request.plan.shouldBackup,
      }
    })
  }

  /** 判断本引擎是否有这个任务。 */
  has(jobId: string): boolean {
    return this.jobs.has(jobId)
  }

  /**
   * 任务的登记请求，包括计划。
   *
   * @throws HttpOperationError 任务不存在或已过保留期时抛 not-found。
   */
  jobRequest(jobId: string): SyncJobRequest {
    return structuredClone(this.job(jobId).request)
  }

  /**
   * 任务两个角色的状态。对方结果待确认且本机已结束时，在后台补读一次对方状态，间隔至少 RECOVER_INTERVAL_MS。
   *
   * @throws HttpOperationError 任务不存在或已过保留期时抛 not-found。
   */
  jobState(jobId: string): SyncTransferState {
    const job = this.job(jobId)
    if (
      !job.isRunning &&
      job.wasRemoteAttempted &&
      job.remoteError !== null &&
      performance.now() - job.recoveredAt >= RECOVER_INTERVAL_MS
    ) {
      // recover 自己记下读取失败，不会 reject。
      this.recover(job).catch(() => undefined)
    }
    return this.transferState(job)
  }

  /**
   * 用户取消任务：先请监听方取消（最多等 SHORT_TIMEOUT_MS），再停下本机，两端都记为取消。
   * 本机已结束而监听方还在运行时，在后台请监听方取消。
   *
   * @throws HttpOperationError 任务不存在时抛 not-found。
   */
  async cancelJob(jobId: string): Promise<SyncTransferState> {
    const job = this.job(jobId)
    if (job.isRunning) {
      job.state = { ...job.state, isCancelRequested: true, updatedAt: Date.now() }
      if (job.wasRemoteAttempted) {
        // 本机先停会关掉内容连接，监听方只看到连接断开，会记成网络中断。
        await this.sendCancel(job)
      }
      job.controller.abort()
    } else if (job.wasRemoteAttempted) {
      // cancelRemote 自己记下读取失败，不会 reject。
      this.cancelRemote(job).catch(() => undefined)
    }
    return this.transferState(job)
  }

  /**
   * 重试任务的缓存清理。
   *
   * @throws HttpOperationError 任务还在运行或其他任务占着名额时抛 busy，清理仍失败时抛 cleanup-failed。
   */
  async cleanupJob(jobId: string): Promise<void> {
    const job = this.job(jobId)
    if (job.isRunning || (this.active !== null && this.active !== job)) {
      throw new HttpOperationError('busy', 'The sync task has not finished.')
    }
    if (!(await this.cleanup(job))) {
      throw new HttpOperationError('cleanup-failed', cleanupFailure().message)
    }
  }

  /** 是否有任务在运行，包括本机已结束而监听方还在写入的任务。 */
  hasRunningWork(): boolean {
    return [...this.jobs.values()].some(
      (job) => job.isRunning || (job.remoteError === null && job.remote?.status === 'running'),
    )
  }

  /** 是否有任务占着写入名额，包括清理失败后待清理的任务。 */
  hasWork(): boolean {
    return this.active !== null
  }

  // ---------- 监听方的请求 ----------

  /** 处理监听方经控制通道发来的复制请求。 */
  async request(
    deviceId: string,
    request: DialerSyncRequest,
  ): Promise<ControlResponseValues[DialerSyncMethod]> {
    this.available()
    switch (request.method) {
      case 'sync.prepare':
        return await this.prepareForListener(deviceId, request.body)
      case 'sync.confirm': {
        const preparation = [...this.preparations.values()].find(
          (item) =>
            item.peerId === deviceId &&
            item.listenerRequestId === request.body.requestId &&
            item.status === 'ready' &&
            !item.isConsumed,
        )
        if (!preparation) {
          throw new HttpOperationError(
            'not-found',
            'This device has no result for this scan. Scan again.',
          )
        }
        this.execute(preparation, {
          shouldBackup: request.body.shouldBackup,
          shouldDeleteExtras: request.body.shouldDeleteExtras,
        })
        return { jobId: preparation.id }
      }
      case 'sync.cancel': {
        if (this.latestListenerRequestId === request.body.requestId) {
          this.latestListenerRequestId = null
        }
        for (const item of this.preparations.values()) {
          if (
            item.peerId === deviceId &&
            item.listenerRequestId === request.body.requestId &&
            !item.isConsumed
          ) {
            this.cancelPreparation(item)
          }
        }
        return null
      }
      case 'sync.job.read': {
        const job = this.jobs.get(request.body.jobId)
        if (job?.preparation.peerId !== deviceId) {
          throw new HttpOperationError('not-found', 'This sync task does not exist.')
        }
        return structuredClone(job.state)
      }
      case 'sync.job.cancel': {
        const job = this.jobs.get(request.body.jobId)
        if (job?.preparation.peerId !== deviceId) {
          throw new HttpOperationError('not-found', 'This sync task does not exist.')
        }
        // 已结束的任务不受影响，结果以读取为准。
        if (job.isRunning) {
          job.state = { ...job.state, isCancelRequested: true, updatedAt: Date.now() }
          job.controller.abort()
        }
        return null
      }
    }
  }

  /** 控制通道关闭时，取消监听方发起、还没确认的准备。 */
  closed(deviceId: string): void {
    for (const item of this.preparations.values()) {
      if (item.peerId === deviceId && item.listenerRequestId !== null && !item.isConsumed) {
        this.cancelPreparation(item)
      }
    }
  }

  private async prepareForListener(
    deviceId: string,
    body: ControlRequestBodies['sync.prepare'],
  ): Promise<null> {
    this.latestListenerRequestId = body.requestId
    // 传输刚结束时等一下再判断，已结束的任务不挡住新扫描。
    const deadline = performance.now() + PREPARE_SETTLE_MS
    while (this.active?.isRunning && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    if (this.active?.isRunning) {
      throw new HttpOperationError('busy', 'This device is still running the previous transfer.')
    }
    // 等待期间监听方已取消，或发来了更新的请求。
    if (this.latestListenerRequestId !== body.requestId) {
      return null
    }
    const preparation = this.prepare(body.projectId, deviceId, body.direction, body.requestId)
    this.emitReport(preparation, { requestId: body.requestId, status: 'preparing' })
    return null
  }

  private emitReport(preparation: Preparation, report: RemoteSyncReport): void {
    try {
      this.options.dialer.emit(preparation.peerId, 'sync.report', report)
    } catch {
      // 控制通道断开时监听方把未确认的请求记为失败，回报丢失不影响结论。
    }
  }

  // ---------- 准备 ----------

  private prepare(
    projectId: string,
    peerId: string,
    direction: SyncDirection,
    listenerRequestId: string | null,
  ): Preparation {
    this.available()
    this.purge()
    const { config, peers } = this.options.library.snapshot()
    const game = config.games.find((item) => item.id === projectId)
    const link = game?.links.find((item) => item.deviceId === peerId)
    const peer = peers.find((item) => item.device.id === peerId)
    const remote = peer?.games.find((item) => item.id === link?.gameId)
    if (!game?.rootId || !link) {
      throw new HttpOperationError(
        'invalid-request',
        'Select a local directory and link the device in Game settings first.',
      )
    }
    if (this.options.dialer.deviceId() !== peerId || !this.options.dialer.isOpen()) {
      throw new HttpOperationError(
        'network-failure',
        'The device is not connected. Connect to it on the Devices page.',
      )
    }
    if (!remote?.root) {
      throw new HttpOperationError(
        'invalid-request',
        'The device has not selected a directory for this game yet.',
      )
    }
    this.options.library.verifyProjectPeer(
      projectId,
      peerId,
      remote.id,
      game.rootId,
      remote.root.rootId,
    )
    const connection = this.options.dialer.connection(peerId)
    if (this.preparations.size >= MAX_RETAINED) {
      throw new HttpOperationError('busy', 'Too many comparisons are retained. Retry later.')
    }
    const preparation: Preparation = {
      id: randomUUID(),
      peerId,
      projectId,
      remoteProjectId: remote.id,
      localRootId: game.rootId,
      remoteRootId: remote.root.rootId,
      direction,
      connection,
      controller: new AbortController(),
      listenerRequestId,
      status: 'preparing',
      plan: null,
      error: null,
      remoteScanId: null,
      wasCancelRequested: false,
      hasTimedOut: false,
      isConsumed: false,
      startedAt: performance.now(),
      settledAt: null,
      updatedAt: Date.now(),
    }
    const superseded = this.preparing
    if (superseded) {
      this.cancelPreparation(superseded)
    }
    this.preparations.set(preparation.id, preparation)
    this.preparing = preparation
    // runPreparation 把失败记进准备的状态，不会 reject。
    this.runPreparation(preparation, superseded).catch(() => undefined)
    return preparation
  }

  /** 扫描两端并生成计划，结果和失败都记进 preparation；不会 reject。 */
  private async runPreparation(
    preparation: Preparation,
    superseded: Preparation | null,
  ): Promise<void> {
    // 正在访问哪一端的目录；失败时写进错误，界面据此说明是哪一端的问题。
    let accessing: ErrorDevice | null = null
    const signal = preparation.controller.signal
    try {
      // 本机扫描器同时只跑一个扫描，等被取代的准备释放它。
      while (superseded?.status === 'preparing') {
        await pause(POLL_MS, signal)
      }
      const { connection } = preparation
      const { dialer, library } = this.options
      await dialer.refreshCatalog(connection)
      library.verifyProjectPeer(
        preparation.projectId,
        preparation.peerId,
        preparation.remoteProjectId,
        preparation.localRootId,
        preparation.remoteRootId,
      )
      await this.checkCapabilities(preparation)
      accessing = 'listener'
      let remote = this.remoteScan(preparation, await this.startRemoteScan(preparation), null)
      preparation.remoteScanId = remote.scanId
      accessing = 'dialer'
      const local = await this.scanLocal(preparation)
      accessing = 'listener'
      while (remote.status === 'running') {
        await pause(POLL_MS, signal)
        remote = this.remoteScan(
          preparation,
          await connection.http.json('GET', route(SYNC_HTTP_ROUTES.scan, 'scanId', remote.scanId), {
            ...this.headers(connection),
            signal,
          }),
          remote.scanId,
        )
      }
      preparation.remoteScanId = null
      if (remote.status !== 'succeeded' || !remote.snapshot) {
        throw new HttpOperationError(
          remote.error?.code ?? 'internal-error',
          remote.error
            ? 'The device directory scan is incomplete.'
            : 'The device scan was cancelled.',
        )
      }
      const descriptor = await connection.http.json(
        'GET',
        route(SYNC_HTTP_ROUTES.project, 'projectId', preparation.remoteProjectId),
        { ...this.headers(connection), signal },
      )
      if (
        !isSyncProjectDescriptor(descriptor) ||
        descriptor.projectId !== preparation.remoteProjectId ||
        descriptor.deviceId !== preparation.peerId ||
        descriptor.rootId !== preparation.remoteRootId
      ) {
        throw new HttpOperationError('invalid-request', 'The device project format is invalid.')
      }
      accessing = null
      const isSending = isDialerSending(preparation.direction)
      dialer.verify(connection)
      library.verifyProjectPeer(
        preparation.projectId,
        preparation.peerId,
        preparation.remoteProjectId,
        preparation.localRootId,
        preparation.remoteRootId,
      )
      checkArchiveAbort(signal)
      const plan = createSyncPlan({
        planId: preparation.id,
        projectId: isSending ? preparation.remoteProjectId : preparation.projectId,
        operation: 'copy',
        direction: preparation.direction,
        shouldBackup: false,
        shouldDeleteExtras: false,
        source: isSending ? local : remote.snapshot,
        target: isSending ? remote.snapshot : local,
      })
      if (Buffer.byteLength(JSON.stringify(plan)) > BATCH_LIMITS.maxJsonBytes) {
        throw new HttpOperationError('resource-limit', 'The plan exceeds the size limit.')
      }
      preparation.plan = plan
      this.settlePreparation(preparation, 'ready', null)
    } catch (cause) {
      const isCancelled =
        !preparation.hasTimedOut &&
        (cause instanceof ArchiveCancelledError || preparation.wasCancelRequested)
      if (isCancelled) {
        this.settlePreparation(preparation, 'cancelled', null)
      } else {
        const error: OperationError = preparation.hasTimedOut
          ? { code: 'timeout', message: 'Sync preparation timed out. Scan again.', canRetry: false }
          : withDevice(toHttpError(cause).operationError, accessing)
        this.settlePreparation(preparation, 'failed', error)
      }
    } finally {
      if (preparation.remoteScanId !== null) {
        // cancelRemoteScan 不会 reject。
        this.cancelRemoteScan(preparation, preparation.remoteScanId).catch(() => undefined)
      }
    }
  }

  private settlePreparation(
    preparation: Preparation,
    status: 'ready' | 'failed' | 'cancelled',
    error: OperationError | null,
  ): void {
    preparation.status = status
    preparation.error = error
    preparation.settledAt = performance.now()
    preparation.updatedAt = Date.now()
    if (this.preparing === preparation) {
      this.preparing = null
    }
    const requestId = preparation.listenerRequestId
    if (requestId === null) {
      return
    }
    if (status === 'ready' && preparation.plan) {
      this.emitReport(preparation, {
        requestId,
        status: 'ready',
        plan: preparation.plan,
      })
    } else if (status === 'failed' && error) {
      this.emitReport(preparation, { requestId, status: 'failed', error })
    }
  }

  private async checkCapabilities(preparation: Preparation): Promise<void> {
    const { connection } = preparation
    let value: unknown
    try {
      value = await connection.http.json('GET', SYNC_HTTP_ROUTES.capabilities, {
        ...this.headers(connection),
        signal: preparation.controller.signal,
      })
    } catch (cause) {
      const code = toHttpError(cause).operationError.code
      if (code === 'not-found' || code === 'unsupported-operation') {
        throw new HttpOperationError('unsupported-operation', 'Update both apps before syncing.')
      }
      throw cause
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      'schemaVersion' in value &&
      value.schemaVersion !== SYNC_CAPABILITIES_VERSION
    ) {
      throw new HttpOperationError('protocol-mismatch', 'Update both apps before syncing.')
    }
    if (!isSyncCapabilities(value) || value.deviceId !== preparation.peerId) {
      throw new HttpOperationError(
        'protocol-mismatch',
        'Sync budgets differ between devices. Update both apps.',
      )
    }
    if (
      value.canScan !== 'supported' ||
      value.canCopy !== 'supported' ||
      value.canBackup !== 'supported'
    ) {
      throw new HttpOperationError(
        'unsupported-operation',
        'The device does not provide this sync capability yet. Update both apps.',
      )
    }
  }

  /** 请监听方开始扫描。它同一时间只跑一个扫描，刚取消的扫描可能还在收尾，等一小会儿再报 busy。 */
  private async startRemoteScan(preparation: Preparation): Promise<unknown> {
    const { connection } = preparation
    const signal = preparation.controller.signal
    const deadline = performance.now() + SCAN_BUSY_WAIT_MS
    for (;;) {
      try {
        return await connection.http.json('POST', SYNC_HTTP_ROUTES.scans, {
          ...this.headers(connection),
          body: { schemaVersion: 1, rootId: preparation.remoteRootId },
          expectedStatus: 202,
          signal,
        })
      } catch (cause) {
        if (toHttpError(cause).operationError.code !== 'busy' || performance.now() >= deadline) {
          throw cause
        }
        await pause(POLL_MS, signal)
      }
    }
  }

  private remoteScan(
    preparation: Preparation,
    value: unknown,
    scanId: string | null,
  ): SyncScanState {
    if (
      !isSyncScanState(value) ||
      value.rootId !== preparation.remoteRootId ||
      (scanId !== null && value.scanId !== scanId) ||
      (value.snapshot !== null &&
        (value.snapshot.deviceId !== preparation.peerId ||
          value.snapshot.rootId !== preparation.remoteRootId ||
          value.snapshot.scanId !== value.scanId))
    ) {
      throw new HttpOperationError('invalid-request', 'The device scan format is invalid.')
    }
    return value
  }

  /** 请监听方取消扫描；不会 reject。 */
  private async cancelRemoteScan(preparation: Preparation, scanId: string): Promise<void> {
    const { connection } = preparation
    try {
      await connection.http.json('DELETE', route(SYNC_HTTP_ROUTES.scan, 'scanId', scanId), {
        ...this.headers(connection),
        expectedStatus: 202,
        timeoutMs: SHORT_TIMEOUT_MS,
      })
    } catch {
      // 只读扫描会自行到期，取消的回执丢失后不重发。
    }
  }

  private async scanLocal(preparation: Preparation): Promise<SyncSnapshot> {
    const { scanner } = this.options
    const signal = preparation.controller.signal
    checkArchiveAbort(signal)
    const scan = scanner.start(preparation.localRootId)
    const abort = (): void => {
      scanner.cancel(scan.scanId)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const state = await scanner.wait(scan.scanId)
      checkArchiveAbort(signal)
      if (state.status !== 'succeeded' || !state.snapshot) {
        throw new HttpOperationError(
          state.error?.code ?? 'internal-error',
          state.error?.message ?? 'The local directory scan is incomplete.',
        )
      }
      return state.snapshot
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private cancelPreparation(preparation: Preparation): void {
    preparation.wasCancelRequested = true
    if (preparation.status === 'preparing') {
      preparation.controller.abort()
    } else if (preparation.status === 'ready' && !preparation.isConsumed) {
      preparation.plan = null
      this.settlePreparation(preparation, 'cancelled', null)
    }
  }

  private shownPreparation(requestId: string): Preparation {
    this.purge()
    if (this.shown?.id !== requestId) {
      throw new HttpOperationError('not-found', 'The initiation request ended. Scan again.')
    }
    return this.shown
  }

  private describe(preparation: Preparation): DesktopRemoteRequest {
    const job = this.jobs.get(preparation.id)
    const base = {
      requestId: preparation.id,
      projectId: preparation.projectId,
      peerId: preparation.peerId,
      direction: preparation.direction,
    }
    if (!job) {
      return {
        ...base,
        status: preparation.status,
        jobId: null,
        error: preparation.error,
        updatedAt: preparation.updatedAt,
      }
    }
    const { phase } = observeSyncJob(job.state, job.remote, job.remoteError !== null)
    const error = job.state.error ?? job.remote?.error ?? job.remoteError
    return {
      ...base,
      status:
        phase === 'running'
          ? 'running'
          : phase === 'done'
            ? 'succeeded'
            : phase === 'cancelled'
              ? 'cancelled'
              : 'failed',
      jobId: job.request.jobId,
      error: phase === 'running' || phase === 'done' || phase === 'cancelled' ? null : error,
      updatedAt: Math.max(job.state.updatedAt, job.remote?.updatedAt ?? 0),
    }
  }

  // ---------- 执行 ----------

  /** 消费一次确认，取得写入名额并开始执行。 */
  private execute(preparation: Preparation, choices: SyncPlanChoices): Job {
    this.available()
    this.purge()
    if (preparation.status !== 'ready' || !preparation.plan || preparation.isConsumed) {
      throw new HttpOperationError('plan-expired', 'The comparison expired. Scan again.')
    }
    const plan = withSyncPlanChoices(preparation.plan, choices)
    if (!plan.canExecute) {
      throw new HttpOperationError('invalid-request', 'This plan cannot be executed. Scan again.')
    }
    const isSending = isDialerSending(preparation.direction)
    const local = isSending ? plan.source : plan.target
    const now = Date.now()
    if (local.observedAt > now || now - local.observedAt > SYNC_LIMITS.snapshotLifetimeMs) {
      throw new HttpOperationError('plan-expired', 'The comparison expired. Scan again.')
    }
    this.options.dialer.verify(preparation.connection)
    this.options.library.verifyProjectPeer(
      preparation.projectId,
      preparation.peerId,
      preparation.remoteProjectId,
      preparation.localRootId,
      preparation.remoteRootId,
    )
    const request: SyncJobRequest = {
      schemaVersion: 1,
      jobId: plan.planId,
      sourceProjectId: isSending ? preparation.projectId : preparation.remoteProjectId,
      targetProjectId: isSending ? preparation.remoteProjectId : preparation.projectId,
      plan,
    }
    if (Buffer.byteLength(JSON.stringify(request)) > BATCH_LIMITS.maxJsonBytes) {
      throw new HttpOperationError('resource-limit', 'The plan exceeds the size limit.')
    }
    if (
      this.active ||
      this.usedIds.has(request.jobId) ||
      this.usedIds.size >= BATCH_LIMITS.maxTransfersPerSession
    ) {
      throw new HttpOperationError('busy', 'A sync task or resources are awaiting cleanup.')
    }
    const files = contentFiles(request)
    const token = Symbol('dialer-sync-job')
    acquireTargetOperation(token)
    let settleContent: (cause?: unknown) => void = () => undefined
    const content = new Promise<void>((resolve, reject) => {
      settleContent = (cause) => {
        if (cause === undefined) {
          resolve()
        } else {
          reject(
            cause instanceof Error ? cause : new Error('Receiving the content failed.', { cause }),
          )
        }
      }
    })
    // 内容可能在写入器等它之前就失败，先挂上处理，避免成为未处理的拒绝。
    content.catch(() => undefined)
    const job: Job = {
      preparation,
      request,
      files,
      token,
      acceptedAt: now,
      startedAt: performance.now(),
      controller: new AbortController(),
      state: {
        schemaVersion: SYNC_JOB_SCHEMA_VERSION,
        jobId: request.jobId,
        direction: plan.direction as SyncDirection,
        role: isSending ? 'sender' : 'receiver',
        status: 'running',
        stage: 'preparing',
        updatedAt: now,
        isCancelRequested: false,
        failureStage: null,
        result: null,
        error: null,
        cleanupError: null,
        progress: {
          transferredBytes: 0,
          totalFileBytes: plan.totalFileBytes ?? 0,
          totalFiles: plan.transferFileCount,
          publishedFiles: 0,
          fileBytesPublished: 0,
          backupBytesCopied: 0,
          totalBackupBytes: syncJobBackupBytes(plan),
        },
      },
      remote: null,
      remoteError: null,
      staged: null,
      content,
      settleContent,
      isRunning: true,
      hasLease: true,
      hasTimedOut: false,
      wasRemoteAttempted: false,
      wasCancelSent: false,
      isUploading: false,
      isUploadComplete: false,
      isBackupDone: false,
      isContentClaimed: false,
      isContentReceived: false,
      isWriting: false,
      endedAt: null,
      reported: null,
      reportedAt: 0,
      recovering: null,
      recoveredAt: 0,
      worker: null,
    }
    // 页面重建后靠计划读回这次确认的选择。
    preparation.plan = plan
    preparation.isConsumed = true
    preparation.updatedAt = now
    this.usedIds.add(request.jobId)
    this.jobs.set(request.jobId, job)
    this.active = job
    job.worker = this.run(job)
    return job
  }

  private async run(job: Job): Promise<void> {
    const { connection } = job.preparation
    const isSending = job.state.role === 'sender'
    try {
      checkArchiveAbort(job.controller.signal)
      await this.options.dialer.refreshCatalog(connection)
      this.verifyContext(job)
      job.wasRemoteAttempted = true
      try {
        this.accept(
          job,
          await connection.http.json('POST', SYNC_HTTP_ROUTES.jobs, {
            ...this.headers(connection),
            body: job.request,
            expectedStatus: 201,
            signal: job.controller.signal,
          }),
        )
      } catch (lost) {
        // 登记的回执可能丢失；只查询同一个任务，不重发登记。
        try {
          await this.refresh(job, job.controller.signal)
        } catch {
          throw lost
        }
      }
      if (isSending) {
        if (job.request.plan.transferFileCount > 0) {
          await this.upload(job)
        } else {
          job.isUploadComplete = true
          this.terminal(job, 'sent', null)
        }
        await this.awaitRemote(job)
      } else {
        await this.download(job)
      }
    } catch (cause) {
      await this.handleFailure(job, cause)
    } finally {
      job.isWriting = false
      // 正常结束和 handleFailure 都会写入终态；两者都没写入时按应用内部错误结束，否则任务会一直显示进行中。
      if (job.state.status === 'running') {
        const stopped = new HttpOperationError(
          'internal-error',
          'The sync task stopped unexpectedly.',
        )
        if (isSending) {
          this.terminal(job, 'failed', knownError(stopped))
        } else {
          this.receiverFailed(job, stopped)
        }
      }
      await this.cleanup(job)
      job.isRunning = false
      job.endedAt = performance.now()
    }
  }

  private async handleFailure(job: Job, cause: unknown): Promise<void> {
    const isSending = job.state.role === 'sender'
    const isCancelled = this.isCancelled(job, cause)
    if (!isSending) {
      if (job.state.status === 'running') {
        this.receiverFailed(job, cause)
      }
    } else if (!job.isUploadComplete) {
      this.terminal(
        job,
        isCancelled ? 'cancelled' : 'failed',
        isCancelled ? null : job.hasTimedOut ? this.timeoutError() : knownError(cause),
      )
    }
    if (!job.wasRemoteAttempted) {
      return
    }
    // 本机接收时总是取消监听方。本机发送时，用户取消、超时或内容没发完才取消；发完后查询失败时，监听方继续写入。
    if (!isSending || !job.isUploadComplete || isCancelled || job.hasTimedOut) {
      await this.cancelRemote(job)
    } else if (job.remote === null || job.remote.status === 'running') {
      job.remoteError = resultUnknown(
        'The connection to the device was lost. The result is unconfirmed.',
      )
    }
  }

  private isCancelled(job: Job, cause: unknown): boolean {
    return (
      !job.hasTimedOut && (cause instanceof ArchiveCancelledError || job.state.isCancelRequested)
    )
  }

  private timeoutError(): KnownOperationError {
    return {
      code: 'timeout',
      message: 'The sync task exceeded its deadline. Query its result.',
      canRetry: false,
    }
  }

  /** 核对当前连接和两端项目关联仍与确认时一致。 */
  private verifyContext(job: Job): void {
    checkArchiveAbort(job.controller.signal)
    const { preparation } = job
    this.options.dialer.verify(preparation.connection)
    this.options.library.verifyProjectPeer(
      preparation.projectId,
      preparation.peerId,
      preparation.remoteProjectId,
      preparation.localRootId,
      preparation.remoteRootId,
    )
  }

  /** 把监听方报告的失败转成本机任务的错误，文件访问类的错误注明在监听方；监听方没报错时为 task-conflict。 */
  private remoteFailure(job: Job, message: string): HttpOperationError {
    const error = job.remote?.error
    if (!error) {
      return new HttpOperationError('task-conflict', message)
    }
    const device = DEVICE_ERRORS.has(error.code) ? 'listener' : undefined
    return new HttpOperationError(error.code, message, undefined, device)
  }

  private isRemoteRunning(job: Job): boolean {
    return job.remote?.status === 'running'
  }

  private remoteStage(job: Job): SyncJobState['stage'] {
    return job.remote?.stage ?? 'preparing'
  }

  private async upload(job: Job): Promise<void> {
    const signal = job.controller.signal
    // 监听方登记后核对容量，通过后立即开始备份，备份期间就可以上传。
    while (this.isRemoteRunning(job) && this.remoteStage(job) === 'preparing') {
      await pause(POLL_MS, signal)
      await this.refresh(job, signal)
    }
    if (
      !this.isRemoteRunning(job) ||
      !['backing-up', 'awaiting-content'].includes(this.remoteStage(job))
    ) {
      throw this.remoteFailure(job, 'The device could not accept this content.')
    }
    const plan = job.request.plan
    const total = plan.totalFileBytes ?? 0
    this.verifyContext(job)
    this.update(job, 'transferring')
    const { connection } = job.preparation
    // 回调里赋值，放在对象里，控制流分析才不会把它当成始终为 null。
    const reading: { error: ArchiveError | null } = { error: null }
    job.isUploading = true
    // 上传期间监听方还在备份时定时读它的状态；不读的话界面的备份进度一直停在 0%。
    const refresher = setInterval(() => {
      if (job.isUploading && this.isRemoteRunning(job) && this.remoteStage(job) === 'backing-up') {
        connection.http
          .json('GET', this.jobPath(job), { ...this.headers(connection), signal })
          .then((value) => {
            // 上传结束后由上传的回执更新状态，晚到的旧状态不能覆盖它。
            if (job.isUploading) {
              this.accept(job, value)
            }
          })
          // 这次刷新只为显示备份进度：读不到时下一轮再读，状态不对时由上传的回执报错。
          .catch(() => undefined)
      }
    }, UPLOAD_TARGET_REFRESH_MS)
    try {
      const receipt = await connection.http.upload(
        `${this.jobPath(job)}/content`,
        { ...this.headers(connection), signal },
        async (destination) => {
          try {
            await this.options.archive.sendFiles(plan.source.rootId, job.files, destination, {
              signal,
              onBytes: (bytes) => this.update(job, 'transferring', { transferredBytes: bytes }),
            })
          } catch (cause) {
            // 读取本机来源失败时按本机的错误结束；连接被关掉造成的失败以监听方的状态为准。
            if (cause instanceof ArchiveError) {
              reading.error = cause
            }
            throw cause
          }
        },
      )
      job.isUploading = false
      this.accept(job, receipt)
    } catch (lost) {
      job.isUploading = false
      if (reading.error) {
        throw reading.error
      }
      checkArchiveAbort(signal)
      await this.refresh(job, signal)
      // 连接断开后监听方可能还没察觉，仍在等内容；先等它按连接断开自己结束，否则随后的取消会被记成用户取消。
      const deadline = performance.now() + UPLOAD_SETTLE_MS
      while (this.isAwaitingUpload(job, total) && performance.now() < deadline) {
        await pause(POLL_MS, signal)
        await this.refresh(job, signal)
      }
      if (this.isAwaitingUpload(job, total)) {
        throw lost
      }
    } finally {
      job.isUploading = false
      clearInterval(refresher)
    }
    const remote = job.remote
    // 监听方的备份或核对先失败时会中止接收，内容没收齐，本机按它报告的错误结束。
    if (remote && !this.isRemoteRunning(job) && remote.progress.transferredBytes < total) {
      throw this.remoteFailure(job, 'The device stopped receiving this content.')
    }
    if (
      remote?.progress.transferredBytes !== total ||
      ['preparing', 'awaiting-content', 'transferring'].includes(remote.stage)
    ) {
      throw new HttpOperationError(
        'invalid-request',
        'The device content receipt does not match this plan.',
      )
    }
    this.update(job, 'transferring', { transferredBytes: total })
    job.isUploadComplete = true
    this.terminal(job, 'sent', null)
  }

  /** 监听方仍在运行，且内容没收齐或还停在等内容、传输阶段时返回 true。 */
  private isAwaitingUpload(job: Job, total: number): boolean {
    return (
      this.isRemoteRunning(job) &&
      ((job.remote?.progress.transferredBytes ?? 0) < total ||
        ['awaiting-content', 'transferring'].includes(this.remoteStage(job)))
    )
  }

  /** 等监听方核对完来源；查询失败且补读也失败时抛出原错误。 */
  private async awaitRemotePrepared(job: Job): Promise<void> {
    await this.awaitRemoteWhile(job, () => this.remoteStage(job) === 'preparing')
  }

  /** 等监听方结束；查询失败且补读也失败时抛出原错误。 */
  private async awaitRemote(job: Job): Promise<void> {
    await this.awaitRemoteWhile(job, () => true)
  }

  private async awaitRemoteWhile(job: Job, condition: () => boolean): Promise<void> {
    const signal = job.controller.signal
    while (this.isRemoteRunning(job) && condition()) {
      await pause(POLL_MS, signal)
      try {
        await this.refresh(job, signal)
      } catch (cause) {
        checkArchiveAbort(signal)
        await this.recover(job)
        // 已重新读到运行状态时继续等同一任务，保持名额，不提前结束。
        if (job.remoteError !== null) {
          throw cause
        }
      }
    }
  }

  /** 备份完成前是备份阶段，之后按内容的进展是等待内容、传输或写入。 */
  private contentStage(job: Job): SyncJobState['stage'] {
    if (!job.isBackupDone) {
      return 'backing-up'
    }
    if (job.isContentReceived) {
      return 'writing'
    }
    return job.isContentClaimed ? 'transferring' : 'awaiting-content'
  }

  /**
   * 边下载边解包到私有缓存，同时由写入器开始备份；内容只能领取一次，全部解包完整后写入器才写入。
   * 内容先失败时停下写入器，按内容的错误结束；写入器先结束时停下下载，按写入器的结果结束。
   */
  private async download(job: Job): Promise<void> {
    const plan = job.request.plan
    const signal = job.controller.signal
    const { connection } = job.preparation
    if (plan.transferFileCount === 0) {
      await this.awaitRemotePrepared(job)
      if (job.remote?.status !== 'sent') {
        throw this.remoteFailure(job, 'The device could not prepare this content.')
      }
      this.verifyContext(job)
      job.isWriting = true
      this.receiverResult(
        job,
        await this.options.writer.apply(plan, null, this.writeOptions(job, signal)),
      )
      return
    }
    this.verifyContext(job)
    const space = await this.options.archive.checkStagingSpace(plan.totalFileBytes ?? 0)
    await this.options.writer.checkSpace(plan, space)
    checkArchiveAbort(signal)
    const writerStop = new AbortController()
    const downloadStop = new AbortController()
    const writerSignal = AbortSignal.any([signal, writerStop.signal])
    const downloadSignal = AbortSignal.any([signal, downloadStop.signal])
    let isContentSettled = false
    let hasWriterStopped = false
    const writing = this.options.writer
      .apply(plan, this.material(job), this.writeOptions(job, writerSignal))
      .finally(() => {
        if (!isContentSettled) {
          hasWriterStopped = true
          downloadStop.abort()
        }
      })
    // 写入器可能在下载还没结束时就失败；先挂上处理，结果在下面等待时再取。
    writing.catch(() => undefined)
    try {
      await this.awaitRemoteWhile(job, () => this.remoteStage(job) === 'preparing')
      if (!this.isRemoteRunning(job) || this.remoteStage(job) !== 'ready') {
        throw this.remoteFailure(job, 'The device could not prepare this content.')
      }
      checkArchiveAbort(downloadSignal)
      const input = await connection.http.download(`${this.jobPath(job)}/content`, {
        ...this.headers(connection),
        signal: downloadSignal,
      })
      job.isContentClaimed = true
      this.update(job, this.contentStage(job))
      // 连接中断时解包只报读取失败；记下应答流自己的第一个错误，按网络中断或超时结束。
      const broken: { error: Error | null } = { error: null }
      input.once('error', (error) => {
        broken.error ??= error
      })
      try {
        job.staged = await this.options.archive.receiveFiles(job.files, input, {
          signal: downloadSignal,
          onBytes: (bytes) => this.update(job, this.contentStage(job), { transferredBytes: bytes }),
        })
      } catch (failure) {
        if (
          downloadSignal.aborted ||
          broken.error === null ||
          broken.error instanceof ArchiveError
        ) {
          throw failure
        }
        throw broken.error instanceof HttpOperationError
          ? broken.error
          : new HttpOperationError(
              'network-failure',
              'The download connection was interrupted before completion.',
              broken.error,
            )
      }
      // 内容已完整解包，本机照常写入；这里只刷新一次监听方的状态，读不到时把它的结果记为待确认。
      await this.recover(job)
    } catch (cause) {
      isContentSettled = true
      job.settleContent(cause)
      if (!hasWriterStopped) {
        writerStop.abort()
      }
      let result: SyncApplyResult | null = null
      try {
        result = await writing
      } catch (writerFailure) {
        if (hasWriterStopped) {
          throw writerFailure
        }
        // 写入器是被下载的失败停下的，任务按下载的原因结束。
      }
      // 写入器只是被取消或超时停下时没有自己的错误，按下载的原因结束，保留取消和超时的判断。
      if (!hasWriterStopped || !result?.error) {
        throw cause
      }
      this.receiverResult(job, result)
      return
    }
    isContentSettled = true
    job.isContentReceived = true
    job.isWriting = true
    this.update(job, this.contentStage(job))
    job.settleContent()
    this.receiverResult(job, await writing)
  }

  private material(job: Job): DesktopSyncMaterial {
    return {
      snapshot: job.request.plan.source,
      openFile: async (entryId) => {
        const file = job.files.find((item) => item.entryId === entryId)
        if (!file || !job.staged) {
          throw new HttpOperationError(
            'invalid-request',
            'The content is missing a source file for this operation.',
          )
        }
        // 解包时已按确认的大小核对，私有缓存不会被别人改动。
        return { stream: await job.staged.openFile(file.fileId), verifyUnchanged: async () => {} }
      },
      ready: () => {
        job.isBackupDone = true
        this.update(job, this.contentStage(job))
        return job.content
      },
    }
  }

  private writeOptions(job: Job, signal: AbortSignal): DesktopSyncWriteOptions {
    return {
      signal,
      lease: { token: job.token, acceptedAt: job.acceptedAt },
      verifyContext: () => this.verifyContext(job),
      // 写入前核对目标是备份的一部分，备份要按核对过的目录复制。
      onStage: (stage) =>
        this.update(job, stage === 'writing' ? 'writing' : this.contentStage(job)),
      onBackupProgress: (bytesCopied) =>
        this.update(job, this.contentStage(job), { backupBytesCopied: bytesCopied }),
      onWriteProgress: (bytesWritten) =>
        this.update(job, 'writing', { fileBytesPublished: bytesWritten }),
      // 字节数已由 onWriteProgress 计入，这里只数文件。
      onOutcome: (outcome) => {
        if (outcome.status === 'succeeded' && isSyncFileWrite(outcome.action)) {
          this.update(job, 'writing', { publishedFiles: job.state.progress.publishedFiles + 1 })
        }
      },
    }
  }

  private update(
    job: Job,
    stage: SyncJobState['stage'],
    progress: Partial<SyncJobProgress> = {},
  ): void {
    if (job.state.status !== 'running') {
      return
    }
    job.state = {
      ...job.state,
      stage,
      updatedAt: Date.now(),
      progress: { ...job.state.progress, ...progress },
    }
  }

  /** 本机作为发送端的终态；sent 只表示本机发送完成。 */
  private terminal(
    job: Job,
    status: 'sent' | 'failed' | 'cancelled',
    error: OperationError | null,
  ): void {
    const actual = status === 'failed' && error?.code === 'result-unknown' ? 'unknown' : status
    job.state = {
      ...job.state,
      status: actual,
      stage: 'done',
      failureStage: actual === 'sent' ? null : failureStageOf(job.state.stage),
      error,
      isCancelRequested: actual === 'cancelled' || job.state.isCancelRequested,
      updatedAt: Date.now(),
    }
  }

  /** 本机作为接收端、还没写入就结束时的完整结果。 */
  private receiverFailed(job: Job, cause: unknown): void {
    const isCancelled = this.isCancelled(job, cause)
    const error = isCancelled ? null : job.hasTimedOut ? this.timeoutError() : knownError(cause)
    this.receiverResult(job, emptyResult(job.request, error, isCancelled))
  }

  private receiverResult(job: Job, value: SyncApplyResult): void {
    const hasCancellation = value.outcomes.some((item) => item.status === 'cancelled')
    const hasAllSucceeded =
      value.error === null && value.outcomes.every((item) => item.status === 'succeeded')
    // 超时引起的取消记为超时；已成功或提交结果不确定的写入，保留实际观察到的结果。
    const timeout = this.timeoutError()
    const result =
      job.hasTimedOut && !hasAllSucceeded && (hasCancellation || value.error === null)
        ? {
            ...value,
            error: timeout,
            outcomes: value.outcomes.map((item): SyncWriteOutcome =>
              item.status === 'cancelled' ? { ...item, status: 'failed', error: timeout } : item,
            ),
          }
        : value
    const isCancelled = result.outcomes.some((item) => item.status === 'cancelled')
    const published = result.outcomes.filter(
      (item) => item.status === 'succeeded' && isSyncFileWrite(item.action),
    )
    const status: SyncJobState['status'] =
      result.error?.code === 'result-unknown'
        ? 'unknown'
        : hasAllSucceeded && !job.hasTimedOut
          ? 'succeeded'
          : result.error === null && isCancelled
            ? 'cancelled'
            : 'failed'
    job.state = {
      ...job.state,
      status,
      stage: 'done',
      failureStage: status === 'succeeded' ? null : failureStageOf(job.state.stage),
      isCancelRequested: status === 'cancelled' || job.state.isCancelRequested,
      updatedAt: Date.now(),
      result,
      error: result.error,
      cleanupError: result.cleanupError,
      progress: {
        ...job.state.progress,
        publishedFiles: published.length,
        fileBytesPublished: published.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
      },
    }
    if (!matchesSyncJobState(structuredClone(job.state), job.request)) {
      // 结果不符合公开校验时停止接受任务，不能把这个错误当成成功。
      const error = resultUnknown(
        'The target result cannot be matched to this confirmation. Read the target again.',
      )
      job.state = { ...job.state, status: 'unknown', error, result: { ...result, error } }
      this.isStopped = true
    }
  }

  // ---------- 监听方的任务状态 ----------

  private jobPath(job: Job): string {
    return route(SYNC_HTTP_ROUTES.job, 'jobId', job.request.jobId)
  }

  private headers(connection: DialerConnection): {
    readonly sessionId: string
    readonly deviceId: string
  } {
    return { sessionId: connection.sessionId, deviceId: connection.localDeviceId }
  }

  private async refresh(job: Job, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    const { connection } = job.preparation
    this.options.dialer.verify(connection)
    this.accept(
      job,
      await connection.http.json('GET', this.jobPath(job), {
        ...this.headers(connection),
        ...(signal ? { signal } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    )
  }

  /** 记下监听方的状态；角色、计划或结果对不上，或者进度倒退、终态改变时抛 invalid-request。 */
  private accept(job: Job, value: unknown): void {
    const previous = job.remote
    if (
      !matchesSyncJobState(value, job.request) ||
      value.role === job.state.role ||
      (previous !== null &&
        ((previous.status !== 'running' &&
          (value.status !== previous.status ||
            JSON.stringify({ ...previous.result, cleanupError: null }) !==
              JSON.stringify({ ...value.result, cleanupError: null }))) ||
          (
            [
              'transferredBytes',
              'fileBytesPublished',
              'publishedFiles',
              'backupBytesCopied',
            ] as const
          ).some((key) => value.progress[key] < previous.progress[key])))
    ) {
      throw new HttpOperationError('invalid-request', 'The device task state is invalid.')
    }
    job.remote = value
    job.remoteError = null
  }

  /** 以 SHORT_TIMEOUT_MS 为期限读一次监听方的状态；读不到时把它的结果记为待确认。不会 reject。 */
  private recover(job: Job): Promise<void> {
    job.recovering ??= (async () => {
      job.recoveredAt = performance.now()
      try {
        await this.refresh(job, undefined, SHORT_TIMEOUT_MS)
      } catch {
        job.remoteError = resultUnknown(
          'The device task state could not be read. The result is unconfirmed.',
        )
      } finally {
        job.recovering = null
      }
    })()
    return job.recovering
  }

  /** 请监听方取消任务并记下它答复的状态；已经发过时不再发，没有回应时之后还可以重发。 */
  private async sendCancel(job: Job): Promise<void> {
    if (job.wasCancelSent) {
      return
    }
    const { connection } = job.preparation
    try {
      const value = await connection.http.json('DELETE', this.jobPath(job), {
        ...this.headers(connection),
        expectedStatus: 202,
        timeoutMs: SHORT_TIMEOUT_MS,
      })
      job.wasCancelSent = true
      this.accept(job, value)
    } catch {
      // 监听方的实际结果由之后的查询确认。
    }
  }

  /** 请监听方取消并等它结束，最多 SHORT_TIMEOUT_MS；读不到时把它的结果记为待确认。不会 reject。 */
  private async cancelRemote(job: Job): Promise<void> {
    const deadline = AbortSignal.timeout(SHORT_TIMEOUT_MS)
    try {
      if (!job.wasCancelSent && (job.remote === null || this.isRemoteRunning(job))) {
        await this.sendCancel(job)
      }
      await this.refresh(job, deadline, SHORT_TIMEOUT_MS)
      while (this.isRemoteRunning(job)) {
        await pause(POLL_MS, deadline)
        await this.refresh(job, deadline, SHORT_TIMEOUT_MS)
      }
    } catch {
      job.remoteError = resultUnknown(
        'The device task state could not be read. The result is unconfirmed.',
      )
    }
  }

  // ---------- 清理、期限和摘要 ----------

  /** 清理缓存和写入候选；成功后释放写入名额，失败时保留名额并记下清理错误。 */
  private async cleanup(job: Job): Promise<boolean> {
    try {
      await this.options.writer.retryCleanup()
      if (job.staged) {
        await job.staged.dispose()
        job.staged = null
      }
      await this.options.archive.retryCleanup()
      job.state = {
        ...job.state,
        cleanupError: null,
        result: job.state.result ? { ...job.state.result, cleanupError: null } : null,
      }
      if (job.hasLease) {
        releaseTargetOperation(job.token)
        job.hasLease = false
      }
      if (this.active === job) {
        this.active = null
      }
      return true
    } catch {
      const error = cleanupFailure()
      job.state = {
        ...job.state,
        cleanupError: error,
        result: job.state.result ? { ...job.state.result, cleanupError: error } : null,
      }
      return false
    }
  }

  private tick(): void {
    const now = performance.now()
    const preparation = this.preparing
    if (
      preparation?.status === 'preparing' &&
      now - preparation.startedAt >= BATCH_TIMEOUTS_MS.total
    ) {
      preparation.hasTimedOut = true
      preparation.controller.abort()
    }
    const job = this.active
    if (job?.isRunning && !job.hasTimedOut && now - job.startedAt >= BATCH_TIMEOUTS_MS.total) {
      job.hasTimedOut = true
      job.controller.abort()
    }
    if (job?.isRunning && job.isWriting) {
      this.heartbeat(job, now)
    }
    this.report(now)
    this.purge()
  }

  /** 本机写入期间定时读一次监听方的任务状态，只核对通信，不记录结果。 */
  private heartbeat(job: Job, now: number): void {
    if (now - this.lastHeartbeat < HEARTBEAT_MS) {
      return
    }
    this.lastHeartbeat = now
    const { connection } = job.preparation
    connection.http
      .json('GET', this.jobPath(job), { ...this.headers(connection), timeoutMs: SHORT_TIMEOUT_MS })
      // 心跳只让监听方记录在线时间，读取失败不影响本机写入。
      .catch(() => undefined)
  }

  /** 推送有变化的任务摘要；进行中的任务没有变化时也每隔 REPORT_INTERVAL_MS 推送一次，作为在线信号。 */
  private report(now: number): void {
    const deviceId = this.options.dialer.deviceId()
    for (const job of this.jobs.values()) {
      if (job.preparation.peerId !== deviceId) {
        continue
      }
      const digest = digestOf(job.state)
      const text = JSON.stringify(digest)
      if (
        text === job.reported &&
        !(job.state.status === 'running' && now - job.reportedAt >= REPORT_INTERVAL_MS)
      ) {
        continue
      }
      try {
        this.options.dialer.emit(job.preparation.peerId, 'sync.job', digest)
        job.reported = text
        job.reportedAt = now
      } catch {
        // 控制通道没开时保留变化，重连后补发。
      }
    }
  }

  private purge(): void {
    const now = performance.now()
    for (const [id, job] of this.jobs) {
      if (
        !job.isRunning &&
        !job.hasLease &&
        job.endedAt !== null &&
        now - job.endedAt >= RETENTION_MS
      ) {
        this.jobs.delete(id)
      }
    }
    while (this.jobs.size > MAX_RETAINED) {
      const oldest = [...this.jobs.values()].find((job) => !job.isRunning && !job.hasLease)
      if (!oldest) {
        break
      }
      this.jobs.delete(oldest.request.jobId)
    }
    for (const [id, preparation] of this.preparations) {
      if (
        preparation !== this.preparing &&
        preparation !== this.shown &&
        !this.jobs.has(id) &&
        preparation.settledAt !== null &&
        now - preparation.settledAt >= RETENTION_MS
      ) {
        this.preparations.delete(id)
      }
    }
    if (
      this.shown &&
      !this.jobs.has(this.shown.id) &&
      this.shown.settledAt !== null &&
      now - this.shown.settledAt >= RETENTION_MS
    ) {
      this.preparations.delete(this.shown.id)
      this.shown = null
    }
  }

  private job(jobId: string): Job {
    this.purge()
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new HttpOperationError(
        'not-found',
        'This sync task ended or expired. Read the directory again.',
      )
    }
    return job
  }

  private transferState(job: Job): SyncTransferState {
    return structuredClone({
      schemaVersion: 1,
      jobId: job.request.jobId,
      local: job.state,
      remote: job.remote,
      remoteError: job.remoteError,
    })
  }

  private available(): void {
    if (this.isStopped) {
      throw new HttpOperationError(
        'unsupported-operation',
        'Copying from this device stopped. Restart the app.',
      )
    }
  }

  /**
   * 停止接受新的准备和任务：取消进行中的准备，用户取消进行中的任务并等它结束和清理。
   *
   * @throws HttpOperationError 清理失败时抛 cleanup-failed，之后可以再次 stop。
   */
  async stop(): Promise<void> {
    this.isStopped = true
    clearInterval(this.timer)
    if (this.preparing) {
      this.cancelPreparation(this.preparing)
    }
    const job = this.active
    if (job?.isRunning) {
      await this.cancelJob(job.request.jobId)
    }
    await job?.worker
    if (job && job.hasLease && !(await this.cleanup(job))) {
      throw new HttpOperationError('cleanup-failed', cleanupFailure().message)
    }
  }
}
