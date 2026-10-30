import { randomUUID } from 'node:crypto'
import type {
  OperationError,
  RemoteSyncReport,
  SyncPlan,
  SyncSnapshot,
  TransferDirection,
} from '@savedata-sync/shared'
import type { DesktopRemoteRequest } from '../bridge/sync-bridge.ts'
import type { ControlHub } from './control-hub.ts'
import type { DesktopLibrary } from './library-store.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

type ActiveStatus = 'waiting' | 'preparing' | 'ready' | 'starting'

interface RemoteEntry {
  value: DesktopRemoteRequest
  readonly remoteProjectId: string
  readonly localRootId: string
  readonly remoteRootId: string
  plan: SyncPlan | null
}

export interface RemoteSyncRequestOptions {
  readonly library: Pick<DesktopLibrary, 'snapshot' | 'verifyProjectPeer'>
  readonly control: Pick<ControlHub, 'isOpen' | 'request'>
  /** 本机设备 ID，用于核对计划里电脑一侧的快照。 */
  readonly deviceId: string
  /** 已有网络传输时拒绝新的发起和确认。 */
  readonly isBusy: () => boolean
  readonly now?: () => number
}

function isActive(status: DesktopRemoteRequest['status']): status is ActiveStatus {
  return ['waiting', 'preparing', 'ready', 'starting'].includes(status)
}
function matchesSide(snapshot: SyncSnapshot, deviceId: string, rootId: string): boolean {
  return snapshot.deviceId === deviceId && snapshot.rootId === rootId
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
      throw new HttpOperationError('not-found', '手机还没有返回本次计划。')
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
      throw new HttpOperationError('busy', '上一个计划已确认，正在等待手机开始传输。')
    }
    if (this.options.isBusy()) {
      throw new HttpOperationError('busy', '还有传输正在进行，请等它结束后再发起。')
    }
    const { config, peers } = this.options.library.snapshot()
    const game = config.games.find((item) => item.id === projectId)
    const peer = peers.find((item) => item.device.id === peerId)
    const link = game?.links.find((item) => item.deviceId === peerId)
    const remote = peer?.games.find((item) => item.id === link?.gameId)
    if (!game?.rootId || !link) {
      throw new HttpOperationError('invalid-request', '请先在目录设置中选择电脑目录并关联手机。')
    }
    if (!peer?.isConnected || !this.options.control.isOpen(peerId)) {
      throw new HttpOperationError('network-failure', '手机未连接，请在手机打开应用并连接电脑。')
    }
    if (!remote?.root) {
      throw new HttpOperationError('invalid-request', '手机还没有为这个游戏选择目录。')
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
        updatedAt: this.now(),
      },
      remoteProjectId: remote.id,
      localRootId: game.rootId,
      remoteRootId: remote.root.rootId,
      plan: null,
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
      throw new HttpOperationError('invalid-request', '本次计划不能执行，请重新扫描。')
    }
    if (this.options.isBusy()) {
      throw new HttpOperationError('busy', '还有传输正在进行，请等它结束后再确认。')
    }
    this.options.library.verifyProjectPeer(
      entry.value.projectId,
      entry.value.peerId,
      entry.remoteProjectId,
      entry.localRootId,
      entry.remoteRootId,
    )
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
            message: '手机开始的任务与本次计划不符，请到任务列表核对。',
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
      throw new HttpOperationError('busy', '手机已在开始传输，请到任务列表取消。')
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
        this.update(entry, { status: 'ready' })
      } else {
        this.fail(entry, {
          code: 'invalid-request',
          message: '手机返回的计划与项目不符，请重新扫描。',
          canRetry: false,
        })
      }
    } else if (report.status === 'failed' && isActive(status)) {
      this.fail(entry, report.error)
    } else if (
      report.status === 'finished' &&
      (status === 'starting' || status === 'running') &&
      report.jobId === entry.plan?.planId
    ) {
      if (report.outcome === 'succeeded') {
        this.update(entry, { status: 'succeeded', jobId: report.jobId })
      } else if (report.outcome === 'cancelled') {
        this.update(entry, { status: 'cancelled', jobId: report.jobId })
      } else {
        this.update(entry, {
          status: 'failed',
          jobId: report.jobId,
          error: report.error ?? {
            code: 'result-unknown',
            message: '传输结果待确认，请到任务列表查看。',
            canRetry: false,
          },
        })
      }
    }
  }

  /** 控制通道断开：未开始的请求失败；已开始的传输仍在进行，结果到任务列表查看。 */
  closed(peerId: string): void {
    const entry = this.current
    if (entry?.value.peerId !== peerId) {
      return
    }
    if (isActive(entry.value.status)) {
      this.fail(entry, {
        code: 'network-failure',
        message: '手机已断开或应用已关闭，请在手机打开应用后重试。',
        canRetry: true,
      })
    } else if (entry.value.status === 'running') {
      this.fail(entry, {
        code: 'network-failure',
        message: '与手机的连接已断开，传输结果请到任务列表查看。',
        canRetry: false,
      })
    }
  }

  private entry(requestId: string): RemoteEntry {
    if (this.current?.value.requestId !== requestId) {
      throw new HttpOperationError('not-found', '发起请求已结束，请重新扫描。')
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
