import { randomUUID } from 'node:crypto'
import { SYNC_JOB_SCHEMA_VERSION, observeSyncJob } from '@savedata-sync/shared'
import type {
  OperationError,
  RemoteSyncReport,
  SyncJobDigest,
  SyncJobRequest,
  SyncJobState,
  SyncPlan,
  SyncSnapshot,
  SyncTransferState,
  TransferDirection,
} from '@savedata-sync/shared'
import type { DesktopCopySummary, DesktopRemoteRequest } from '../bridge/sync-bridge.ts'
import type { ControlHub } from './control-hub.ts'
import type { DesktopLibrary } from './library-store.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { emptyResult } from './sync-registry.ts'

type ActiveStatus = 'waiting' | 'preparing' | 'ready' | 'starting'

interface RemoteEntry {
  value: DesktopRemoteRequest
  readonly remoteProjectId: string
  readonly localRootId: string
  readonly remoteRootId: string
  plan: SyncPlan | null
  /** 已确认、手机还没在电脑上登记任务；登记后任务由 WindowsSyncRegistry 负责。 */
  isAwaitingJob: boolean
  /** 手机最新的任务摘要。 */
  digest: SyncJobDigest | null
}

export interface RemoteSyncRequestOptions {
  readonly library: Pick<DesktopLibrary, 'snapshot' | 'verifyProjectPeer'>
  readonly control: Pick<ControlHub, 'isOpen' | 'request'>
  /** 本机设备 ID，用于核对计划里电脑一侧的快照。 */
  readonly deviceId: string
  /** 已有网络传输时拒绝新的发起和确认。 */
  readonly isBusy: () => boolean
  /** 手机是否已在电脑上登记了这个任务。 */
  readonly hasJob: (jobId: string) => boolean
  readonly now?: () => number
}

function isActive(status: DesktopRemoteRequest['status']): status is ActiveStatus {
  return ['waiting', 'preparing', 'ready', 'starting'].includes(status)
}
function matchesSide(snapshot: SyncSnapshot, deviceId: string, rootId: string): boolean {
  return snapshot.deviceId === deviceId && snapshot.rootId === rootId
}
/** 手机还没登记任务时本机角色的占位状态；等待中是准备阶段，结束后沿用手机报告的结论。 */
function pendingLocalState(entry: RemoteEntry, request: SyncJobRequest): SyncJobState {
  const { status, direction, error, updatedAt } = entry.value
  const plan = request.plan
  const isReceiver = direction === 'android-to-windows'
  const base: SyncJobState = {
    schemaVersion: SYNC_JOB_SCHEMA_VERSION,
    jobId: request.jobId,
    direction,
    role: isReceiver ? 'receiver' : 'sender',
    status: 'running',
    stage: 'preparing',
    updatedAt,
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
      totalFileBytes: plan.totalFileBytes ?? 0,
      totalArchiveBytes: plan.transferFileCount === 0 ? 0 : null,
      totalFiles: plan.transferFileCount,
      verifiedFiles: 0,
      publishedFiles: 0,
    },
  }
  if (status !== 'failed' && status !== 'cancelled') {
    return base
  }
  const wasCancelled = status === 'cancelled'
  const reason = wasCancelled ? null : error
  return {
    ...base,
    status: wasCancelled ? 'cancelled' : reason?.code === 'result-unknown' ? 'unknown' : 'failed',
    stage: 'done',
    cancelRequested: wasCancelled,
    failureStage: entry.digest?.failureStage ?? null,
    error: reason,
    result: isReceiver ? emptyResult(request, reason, wasCancelled) : null,
  }
}

/**
 * 电脑发起复制的会话内登记表，同一时间只保留一个请求。
 * 经控制通道请手机扫描，手机回报计划；电脑确认后由手机执行，并回报最终结果。
 * 请求只存内存，服务停止即丢弃。
 */
export class WindowsRemoteSyncRequests {
  private current: RemoteEntry | null = null
  private readonly options: RemoteSyncRequestOptions
  private readonly now: () => number

  constructor(options: RemoteSyncRequestOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** 返回当前请求的快照；没有请求时返回 null。 */
  state(): DesktopRemoteRequest | null {
    return this.current ? { ...this.current.value } : null
  }

  /** 读取手机回报的计划；只有 ready 及之后的请求有计划，否则抛 not-found。 */
  plan(requestId: string): SyncPlan {
    const entry = this.entry(requestId)
    if (!entry.plan) {
      throw new HttpOperationError('not-found', 'The phone has not returned this plan yet.')
    }
    return entry.plan
  }

  /**
   * 请已连接手机扫描。项目必须已关联在线手机；已确认的请求还没开始或已有网络传输时抛 busy，
   * 关联失效时抛 session-mismatch。未确认的旧请求被新请求取代，手机收到新请求时释放旧扫描。
   * 扫描是否开始由手机随后回报。
   */
  start(projectId: string, peerId: string, direction: TransferDirection): DesktopRemoteRequest {
    if (this.current?.value.status === 'starting') {
      throw new HttpOperationError(
        'busy',
        'The previous plan is confirmed. Waiting for the phone to start transferring.',
      )
    }
    if (this.options.isBusy()) {
      throw new HttpOperationError(
        'busy',
        'A transfer is still running. Wait for it to finish before starting another.',
      )
    }
    const { config, peers } = this.options.library.snapshot()
    const game = config.games.find((item) => item.id === projectId)
    const peer = peers.find((item) => item.device.id === peerId)
    const link = game?.links.find((item) => item.deviceId === peerId)
    const remote = peer?.games.find((item) => item.id === link?.gameId)
    if (!game?.rootId || !link) {
      throw new HttpOperationError(
        'invalid-request',
        'Select a PC directory and link the phone in Game settings first.',
      )
    }
    if (!peer?.isConnected || !this.options.control.isOpen(peerId)) {
      throw new HttpOperationError(
        'network-failure',
        'The phone is not connected. Open the app on the phone and connect to the PC.',
      )
    }
    if (!remote?.root) {
      throw new HttpOperationError(
        'invalid-request',
        'The phone has not selected a directory for this game yet.',
      )
    }
    this.options.library.verifyProjectPeer(
      projectId,
      peerId,
      remote.id,
      game.rootId,
      remote.root.rootId,
    )
    const entry: RemoteEntry = {
      value: {
        requestId: randomUUID(),
        projectId,
        peerId,
        direction,
        status: 'waiting',
        jobId: null,
        error: null,
        backupKeepCount: null,
        updatedAt: this.now(),
      },
      remoteProjectId: remote.id,
      localRootId: game.rootId,
      remoteRootId: remote.root.rootId,
      plan: null,
      isAwaitingJob: false,
      digest: null,
    }
    const previous = this.current
    if (previous && isActive(previous.value.status)) {
      this.update(previous, { status: 'cancelled' })
      this.options.control
        .request(previous.value.peerId, 'sync.cancel', { requestId: previous.value.requestId })
        .catch(() => undefined)
    }
    this.current = entry
    this.options.control
      .request(peerId, 'sync.prepare', {
        requestId: entry.value.requestId,
        projectId: remote.id,
        direction,
      })
      .catch((error: unknown) => {
        if (this.current === entry && isActive(entry.value.status)) {
          this.fail(entry, toHttpError(error).operationError)
        }
      })
    return { ...entry.value }
  }

  /** 确认手机回报的计划；只接受可执行的 ready 计划，手机应答后即视为已开始。 */
  confirm(requestId: string): DesktopRemoteRequest {
    const entry = this.entry(requestId)
    const plan = entry.plan
    if (entry.value.status !== 'ready' || !plan?.canExecute) {
      throw new HttpOperationError('invalid-request', 'This plan cannot be executed. Scan again.')
    }
    if (this.options.isBusy()) {
      throw new HttpOperationError(
        'busy',
        'A transfer is still running. Wait for it to finish before confirming.',
      )
    }
    this.options.library.verifyProjectPeer(
      entry.value.projectId,
      entry.value.peerId,
      entry.remoteProjectId,
      entry.localRootId,
      entry.remoteRootId,
    )
    entry.isAwaitingJob = true
    this.update(entry, { status: 'starting' })
    this.options.control
      .request(entry.value.peerId, 'sync.confirm', { requestId })
      .then(({ jobId }) => {
        if (this.current !== entry || entry.value.status !== 'starting') {
          return
        }
        if (jobId === plan.planId) {
          this.update(entry, { status: 'running', jobId })
        } else {
          this.fail(entry, {
            code: 'invalid-request',
            message: 'The task started by the phone does not match this plan. Check the task list.',
            canRetry: false,
          })
        }
      })
      .catch((error: unknown) => {
        if (this.current === entry && entry.value.status === 'starting') {
          this.fail(entry, toHttpError(error).operationError)
        }
      })
    return { ...entry.value }
  }

  /** 确认前可取消，手机随即释放本次扫描；已开始的传输到任务列表取消。 */
  cancel(requestId: string): DesktopRemoteRequest {
    const entry = this.entry(requestId)
    if (entry.value.status === 'starting') {
      throw new HttpOperationError(
        'busy',
        'The phone is already starting the transfer. Cancel it from the task list.',
      )
    }
    if (isActive(entry.value.status)) {
      this.update(entry, { status: 'cancelled' })
      this.options.control
        .request(entry.value.peerId, 'sync.cancel', { requestId })
        .catch(() => undefined)
    }
    return { ...entry.value }
  }

  /** 应用手机的回报；不属于当前请求或当前状态的回报直接忽略。 */
  report(peerId: string, report: RemoteSyncReport): void {
    const entry = this.current
    if (entry?.value.peerId !== peerId || entry.value.requestId !== report.requestId) {
      return
    }
    const status = entry.value.status
    if (report.status === 'preparing' && status === 'waiting') {
      this.update(entry, { status: 'preparing' })
    } else if (report.status === 'ready' && (status === 'waiting' || status === 'preparing')) {
      if (this.matchesPlan(entry, report.plan)) {
        entry.plan = report.plan
        this.update(entry, { status: 'ready', backupKeepCount: report.backupKeepCount })
      } else {
        this.fail(entry, {
          code: 'invalid-request',
          message: 'The plan returned by the phone does not match the project. Scan again.',
          canRetry: false,
        })
      }
    } else if (report.status === 'failed' && isActive(status)) {
      this.fail(entry, report.error)
    }
  }

  /**
   * 手机的任务摘要。确认后请求的状态跟随它；之前因断开或应答超时记成失败的请求，
   * 收到摘要说明手机确实在执行，也会回到进行中。
   */
  observe(peerId: string, digest: SyncJobDigest): void {
    const entry = this.current
    if (
      entry?.value.peerId !== peerId ||
      entry.plan?.planId !== digest.jobId ||
      !['starting', 'running', 'failed'].includes(entry.value.status)
    ) {
      return
    }
    entry.digest = digest
    const jobId = digest.jobId
    if (digest.status === 'running') {
      this.update(entry, { status: 'running', jobId, error: null })
    } else if (digest.status === 'cancelled') {
      this.update(entry, { status: 'cancelled', jobId, error: null })
    } else if (digest.error) {
      this.update(entry, { status: 'failed', jobId, error: digest.error })
    } else {
      this.update(entry, { status: 'succeeded', jobId, error: null })
    }
  }

  /**
   * 已确认但手机还没在电脑上登记的任务：详情和列表用它显示等待状态，或开始前的失败。
   * 手机登记后返回 null，任务改由 WindowsSyncRegistry 提供。
   */
  pending(): {
    readonly request: SyncJobRequest
    readonly state: SyncTransferState
    readonly summary: DesktopCopySummary
  } | null {
    const entry = this.current
    const plan = entry?.plan
    if (!entry?.isAwaitingJob || !plan) {
      return null
    }
    if (this.options.hasJob(plan.planId)) {
      entry.isAwaitingJob = false
      return null
    }
    const status = entry.value.status
    if (status === 'succeeded') {
      return null
    }
    const isUpload = entry.value.direction === 'android-to-windows'
    const request: SyncJobRequest = {
      schemaVersion: 1,
      jobId: plan.planId,
      sourceProjectId: isUpload ? entry.remoteProjectId : entry.value.projectId,
      targetProjectId: isUpload ? entry.value.projectId : entry.remoteProjectId,
      plan,
    }
    const local = pendingLocalState(entry, request)
    const digest = entry.digest
    // 接收端的终态必须带逐项结果；手机还没开始就结束，没有结果可读，结论看 local。
    const remote =
      digest && (digest.role === 'sender' || digest.status === 'running')
        ? { ...digest, result: null }
        : null
    const { phase, stage, step, percent, hasCleanupError } = observeSyncJob(local, remote, false)
    return {
      request,
      state: { schemaVersion: 1, jobId: plan.planId, local, remote, remoteError: null },
      summary: {
        jobId: plan.planId,
        projectId: entry.value.projectId,
        peerId: entry.value.peerId,
        direction: entry.value.direction,
        role: local.role,
        phase,
        stage,
        step,
        percent,
        updatedAt: entry.value.updatedAt,
        hasCleanupError,
      },
    }
  }

  /** 取消手机正在开始的任务；手机还没建立任务时以 not-found 拒绝。 */
  async cancelPending(jobId: string): Promise<void> {
    const entry = this.current
    if (entry?.plan?.planId !== jobId) {
      throw new HttpOperationError('not-found', 'This sync task ended or expired.')
    }
    await this.options.control.request(entry.value.peerId, 'sync.job.cancel', { jobId })
  }

  /** 控制通道断开：未确认的请求失败；已开始的传输可能仍在进行，结果待确认，重连后由摘要更新。 */
  closed(peerId: string): void {
    const entry = this.current
    if (entry?.value.peerId !== peerId) {
      return
    }
    if (isActive(entry.value.status)) {
      this.fail(entry, {
        code: 'network-failure',
        message: 'The phone disconnected or the app closed. Open the app on the phone and retry.',
        canRetry: true,
      })
    } else if (entry.value.status === 'running') {
      this.fail(entry, {
        code: 'result-unknown',
        message: 'The connection to the phone was lost. The transfer result is unconfirmed.',
        canRetry: false,
      })
    }
  }

  private entry(requestId: string): RemoteEntry {
    if (this.current?.value.requestId !== requestId) {
      throw new HttpOperationError('not-found', 'The initiation request ended. Scan again.')
    }
    return this.current
  }

  /** 方向、目标一侧的项目及两端快照的设备和目录都要与登记时一致。 */
  private matchesPlan(entry: RemoteEntry, plan: SyncPlan): boolean {
    const peer = { deviceId: entry.value.peerId, rootId: entry.remoteRootId }
    const local = { deviceId: this.options.deviceId, rootId: entry.localRootId }
    const isUpload = entry.value.direction === 'android-to-windows'
    const [source, target] = isUpload ? [peer, local] : [local, peer]
    // 计划的项目 ID 取目标一侧：手机 → 电脑时是电脑的项目。
    return (
      plan.operation === 'copy' &&
      plan.direction === entry.value.direction &&
      plan.projectId === (isUpload ? entry.value.projectId : entry.remoteProjectId) &&
      matchesSide(plan.source, source.deviceId, source.rootId) &&
      matchesSide(plan.target, target.deviceId, target.rootId)
    )
  }

  private fail(entry: RemoteEntry, error: OperationError): void {
    this.update(entry, { status: 'failed', error })
  }

  private update(entry: RemoteEntry, change: Partial<DesktopRemoteRequest>): void {
    entry.value = { ...entry.value, ...change, updatedAt: this.now() }
  }
}
