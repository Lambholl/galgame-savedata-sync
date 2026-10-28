import { randomUUID } from 'node:crypto'
import { BATCH_TIMEOUTS_MS, SYNC_LIMITS, isOpaqueId, matchesSyncPlan } from '@savedata-sync/shared'
import type { OperationError, SyncApplyResult, SyncPlan } from '@savedata-sync/shared'
import type { DesktopRestoreState, DesktopRestoreSummary } from '../bridge/sync-bridge.ts'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import type { WindowsBackupStore } from './backup-store.ts'
import type { DesktopLibrary } from './library-store.ts'
import type { WindowsRestorePreparation, WindowsSyncWriter } from './sync-writer.ts'
import { WindowsSyncScanner } from './sync-scanner.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import { ArchiveCancelledError, checkArchiveAbort } from './archive-errors.ts'
import { acquireTargetOperation, releaseTargetOperation } from './target-operation.ts'

interface RestoreJob {
  readonly id: string
  readonly token: symbol
  readonly projectId: string
  readonly rootId: string
  readonly backupId: string
  controller: AbortController
  state: DesktopRestoreState
  preparation: WindowsRestorePreparation | null
  plan: SyncPlan | null
  worker: Promise<void> | null
  timeout: ReturnType<typeof setTimeout> | null
  settledAt: number
  acceptedAt: number
  isWorking: boolean
  hasLease: boolean
  hasTimedOut: boolean
  hasBackupCleanup: boolean
}
interface RestoreOptions {
  readonly source: WindowsDirectoryAdapter
  readonly backups: WindowsBackupStore
  readonly writer: WindowsSyncWriter
  readonly library: DesktopLibrary
}
function cleanupError(): OperationError {
  return {
    code: 'cleanup-failed',
    message: '本次恢复仍有资源或备份待清理，请重试清理。',
    canRetry: false,
  }
}

/** 应用进程持有异步本机恢复；普通准备不占传输名额，页面退出不取消已确认写入。 */
export class WindowsRestoreRegistry {
  private readonly options: RestoreOptions
  private readonly jobs = new Map<string, RestoreJob>()
  private readonly timer: ReturnType<typeof setInterval>
  private confirmed = 0
  private isStopped = false
  private isExpiring = false
  private expiration: Promise<void> | null = null
  constructor(options: RestoreOptions) {
    this.options = options
    this.timer = setInterval(() => {
      if (!this.expiration) {
        this.expiration = this.expire().finally(() => {
          this.expiration = null
        })
      }
    }, 1000)
    this.timer.unref()
  }
  private verify(job: RestoreJob): void {
    if (
      !this.options.library
        .snapshot()
        .config.games.some((game) => game.id === job.projectId && game.rootId === job.rootId)
    ) {
      throw new HttpOperationError(
        'permission-denied',
        '游戏目录已更改，请重新读取备份和当前目录。',
      )
    }
  }
  private find(id: string): RestoreJob {
    const job = this.jobs.get(id)
    if (!isOpaqueId(id) || !job) {
      throw new HttpOperationError('not-found', '本次恢复已释放或过期，请重新读取备份。')
    }
    return job
  }
  private touch(job: RestoreJob): void {
    job.state = { ...job.state, isWorking: job.isWorking, updatedAt: Date.now() }
  }
  private arm(job: RestoreJob): void {
    if (job.timeout) {
      clearTimeout(job.timeout)
    }
    job.timeout = setTimeout(() => {
      job.hasTimedOut = true
      job.controller.abort(new HttpOperationError('timeout', '本次恢复操作已超时，请重新扫描。'))
    }, BATCH_TIMEOUTS_MS.total)
    job.timeout.unref()
  }
  summaries(): readonly DesktopRestoreSummary[] {
    return [...this.jobs.values()].map(({ state, isWorking }) => ({
      restoreId: state.restoreId,
      projectId: state.projectId,
      rootId: state.rootId,
      backupId: state.backupId,
      status: state.status,
      stage: state.stage,
      updatedAt: state.updatedAt,
      hasCleanupError: state.hasCleanupError,
      isWorking,
    }))
  }
  state(id: string): DesktopRestoreState {
    const job = this.find(id)
    return structuredClone({ ...job.state, isWorking: job.isWorking })
  }
  preview(id: string): SyncPlan {
    const job = this.find(id)
    if (!job.plan) {
      throw new HttpOperationError('task-conflict', '当前恢复预览尚未准备好。')
    }
    return structuredClone(job.plan)
  }
  /** 先返回普通准备任务；目标扫描及备份材料验证均由原生执行，服务未启动也可恢复。 */
  prepare(projectId: string, rootId: string, backupId: string): DesktopRestoreState {
    if (![projectId, rootId, backupId].every(isOpaqueId)) {
      throw new HttpOperationError('invalid-request', '恢复引用无效。')
    }
    if (this.isStopped || [...this.jobs.values()].some((job) => job.isWorking)) {
      throw new HttpOperationError('busy', '上一项恢复操作尚未结束。')
    }
    if (this.jobs.size >= 32) {
      const previous = [...this.jobs.values()].find(
        (job) => !job.isWorking && !job.hasLease && !job.preparation && !job.state.hasCleanupError,
      )
      if (previous) {
        this.jobs.delete(previous.id)
      }
    }
    if (this.jobs.size >= 32) {
      throw new HttpOperationError('resource-limit', '恢复预览数量已达上限，请先释放不用的预览。')
    }
    const id = randomUUID(),
      job: RestoreJob = {
        id,
        token: Symbol('restore'),
        projectId,
        rootId,
        backupId,
        controller: new AbortController(),
        preparation: null,
        plan: null,
        worker: null,
        timeout: null,
        settledAt: 0,
        acceptedAt: 0,
        isWorking: true,
        hasLease: false,
        hasTimedOut: false,
        hasBackupCleanup: false,
        state: {
          restoreId: id,
          projectId,
          rootId,
          backupId,
          status: 'preparing',
          stage: 'preparing',
          isWorking: true,
          updatedAt: Date.now(),
          hasCleanupError: false,
          progress: {
            publishedFiles: 0,
            totalFiles: 0,
            fileBytesPublished: 0,
            totalFileBytes: null,
          },
          result: null,
          error: null,
          cleanupError: null,
        },
      }
    this.verify(job)
    this.jobs.set(id, job)
    this.arm(job)
    job.worker = this.prepareNow(job)
    return this.state(id)
  }
  private async prepareNow(job: RestoreJob): Promise<void> {
    const scanner = new WindowsSyncScanner(this.options.source)
    let scanId: string | null = null
    const cancel = (): void => {
      if (scanId !== null) {
        scanner.cancel(scanId)
      }
    }
    try {
      this.verify(job)
      checkArchiveAbort(job.controller.signal)
      const scan = scanner.start(job.rootId)
      scanId = scan.scanId
      job.controller.signal.addEventListener('abort', cancel, { once: true })
      if (job.controller.signal.aborted) {
        cancel()
      }
      const current = await scanner.wait(scan.scanId)
      checkArchiveAbort(job.controller.signal)
      if (!current.snapshot) {
        throw new HttpOperationError(
          current.error?.code ?? 'io-failure',
          current.error?.message ?? '当前目录扫描未完成。',
        )
      }
      job.preparation = await this.options.writer.prepareRestore(
        job.projectId,
        job.rootId,
        job.backupId,
        current.snapshot,
      )
      this.verify(job)
      checkArchiveAbort(job.controller.signal)
      job.plan = job.preparation.plan
    } catch (cause) {
      this.fail(job, cause)
    } finally {
      job.controller.signal.removeEventListener('abort', cancel)
      try {
        await scanner.stop()
      } catch (cause) {
        this.fail(job, cause)
      }
      if (job.state.status === 'preparing') {
        job.state = {
          ...job.state,
          status: 'ready',
          stage: 'ready',
          progress: {
            publishedFiles: 0,
            fileBytesPublished: 0,
            totalFiles: job.plan?.transferFileCount ?? 0,
            totalFileBytes: job.plan?.totalFileBytes ?? null,
          },
        }
      } else {
        await this.clean(job)
      }
      this.settled(job)
    }
  }
  /** 消费与本次原生预览相同的计划；先同步占名额，后开始保护及写入，重复确认拒绝。 */
  execute(id: string, value: unknown): DesktopRestoreState {
    const job = this.find(id)
    if (
      this.isStopped ||
      job.isWorking ||
      job.state.hasCleanupError ||
      job.state.status !== 'ready' ||
      !job.preparation ||
      !job.plan
    ) {
      throw new HttpOperationError('task-conflict', '恢复预览已使用、资源待清理或尚未准备好。')
    }
    if (performance.now() - job.settledAt >= SYNC_LIMITS.snapshotLifetimeMs) {
      throw new HttpOperationError('not-found', '恢复预览已过期，请重新扫描。')
    }
    if (
      !job.plan.canExecute ||
      !matchesSyncPlan(value, {
        planId: job.plan.planId,
        projectId: job.plan.projectId,
        operation: job.plan.operation,
        direction: job.plan.direction,
        shouldBackup: job.plan.shouldBackup,
        source: job.plan.source,
        target: job.plan.target,
      })
    ) {
      throw new HttpOperationError('invalid-request', '确认计划与原生预览不同或存在冲突。')
    }
    if (this.confirmed >= BATCH_LIMITS_PER_PROCESS) {
      throw new HttpOperationError('resource-limit', '本进程恢复确认数量已达上限。')
    }
    this.verify(job)
    acquireTargetOperation(job.token)
    job.hasLease = true
    job.isWorking = true
    job.controller = new AbortController()
    job.hasTimedOut = false
    job.acceptedAt = Date.now()
    this.confirmed++
    job.state = { ...job.state, status: 'running', stage: 'verifying', error: null }
    this.touch(job)
    this.arm(job)
    job.worker = this.executeNow(job)
    return this.state(id)
  }
  private async executeNow(job: RestoreJob): Promise<void> {
    try {
      const preparation = job.preparation
      if (!preparation) {
        throw new HttpOperationError('task-conflict', '本次恢复材料已释放。')
      }
      const result = await preparation.apply({
        signal: job.controller.signal,
        lease: { token: job.token, acceptedAt: job.acceptedAt },
        verifyContext: () => this.verify(job),
        onStage: (stage) => {
          job.state = { ...job.state, stage: stage === 'checking' ? 'verifying' : stage }
          this.touch(job)
        },
        onOutcome: (outcome) => {
          if (outcome.status === 'succeeded' && outcome.action !== 'create-directory') {
            job.state = {
              ...job.state,
              progress: {
                ...job.state.progress,
                publishedFiles: job.state.progress.publishedFiles + 1,
                fileBytesPublished:
                  job.state.progress.fileBytesPublished + (outcome.sizeBytes ?? 0),
              },
            }
            this.touch(job)
          }
        },
      })
      this.result(job, result)
    } catch (cause) {
      this.fail(job, cause)
    } finally {
      await this.clean(job)
      this.settled(job)
    }
  }
  private result(job: RestoreJob, value: SyncApplyResult): void {
    let result = value
    if (job.hasTimedOut && result.outcomes.some((item) => item.status === 'cancelled')) {
      const error = toHttpError(
        new HttpOperationError('timeout', '本次恢复已超时。'),
      ).operationError
      result = {
        ...result,
        error,
        outcomes: result.outcomes.map((item) =>
          item.status === 'cancelled' ? { ...item, status: 'failed', error } : item,
        ),
      }
    }
    const hasSucceeded =
      result.error === null && result.outcomes.every((item) => item.status === 'succeeded')
    const wasCancelled = result.outcomes.some((item) => item.status === 'cancelled')
    const files = result.outcomes.filter(
      (item) => item.status === 'succeeded' && item.action !== 'create-directory',
    )
    job.hasBackupCleanup = result.cleanupError !== null
    job.state = {
      ...job.state,
      status:
        result.error?.code === 'result-unknown'
          ? 'unknown'
          : hasSucceeded
            ? 'succeeded'
            : wasCancelled
              ? 'cancelled'
              : 'failed',
      stage: 'done',
      result,
      error: result.error,
      cleanupError: result.cleanupError,
      hasCleanupError: result.cleanupError !== null,
      progress: {
        ...job.state.progress,
        publishedFiles: files.length,
        fileBytesPublished: files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
      },
    }
    this.touch(job)
  }
  private fail(job: RestoreJob, cause: unknown): void {
    const wasCancelled =
      !job.hasTimedOut && (job.controller.signal.aborted || cause instanceof ArchiveCancelledError)
    job.state = {
      ...job.state,
      status: wasCancelled ? 'cancelled' : 'failed',
      stage: 'done',
      error: wasCancelled
        ? null
        : toHttpError(
            job.hasTimedOut
              ? new HttpOperationError('timeout', '本次恢复操作已超时，请重新扫描。')
              : cause,
          ).operationError,
    }
    this.touch(job)
  }
  private settled(job: RestoreJob): void {
    if (job.timeout) {
      clearTimeout(job.timeout)
    }
    job.timeout = null
    job.isWorking = false
    job.settledAt = performance.now()
    this.touch(job)
  }
  private async clean(job: RestoreJob): Promise<boolean> {
    if (!job.preparation && !job.hasLease && !job.hasBackupCleanup) {
      return true
    }
    const temporary = job.hasLease ? null : Symbol('restore-cleanup')
    try {
      if (temporary) {
        acquireTargetOperation(temporary)
      }
      if (job.hasLease) {
        await this.options.writer.retryCleanup()
      }
      if (job.preparation) {
        try {
          await job.preparation.close()
          job.preparation = null
        } catch (cause) {
          job.hasBackupCleanup = true
          throw cause
        }
      }
      if (job.hasBackupCleanup) {
        const listing = await this.options.backups.list(job.projectId, job.rootId)
        if (listing.incomplete.length > 0) {
          throw new HttpOperationError('cleanup-failed', '请先在备份页检查并清理未完成的备份。')
        }
        await this.options.backups.rotate(job.projectId, job.rootId)
        job.hasBackupCleanup = false
      }
      job.state = {
        ...job.state,
        hasCleanupError: false,
        isWorking: job.isWorking,
        cleanupError: null,
        result: job.state.result ? { ...job.state.result, cleanupError: null } : null,
      }
      if (job.hasLease) {
        releaseTargetOperation(job.token)
        job.hasLease = false
      }
      return true
    } catch {
      job.state = {
        ...job.state,
        hasCleanupError: true,
        cleanupError: cleanupError(),
        result: job.state.result ? { ...job.state.result, cleanupError: cleanupError() } : null,
      }
      return false
    } finally {
      if (temporary) {
        releaseTargetOperation(temporary)
      }
    }
  }
  async cancel(id: string): Promise<DesktopRestoreState> {
    const job = this.find(id)
    job.controller.abort(new ArchiveCancelledError())
    if (!job.isWorking && job.state.status === 'ready') {
      job.state = { ...job.state, status: 'cancelled', stage: 'done' }
      await this.clean(job)
      this.settled(job)
    }
    return this.state(id)
  }
  async retryCleanup(id: string): Promise<DesktopRestoreState> {
    const job = this.find(id)
    if (job.isWorking) {
      throw new HttpOperationError('busy', '恢复操作尚未结束。')
    }
    await this.clean(job)
    this.touch(job)
    return this.state(id)
  }
  async release(id: string): Promise<void> {
    const job = this.find(id)
    if (job.isWorking) {
      throw new HttpOperationError('busy', '恢复操作尚未结束。')
    }
    if (!(await this.clean(job))) {
      throw new HttpOperationError('cleanup-failed', '恢复材料尚未释放，请重试清理。')
    }
    this.jobs.delete(id)
  }
  hasRunningWork(): boolean {
    return [...this.jobs.values()].some((job) => job.isWorking)
  }
  private async expire(): Promise<void> {
    if (this.isStopped || this.isExpiring) {
      return
    }
    this.isExpiring = true
    try {
      for (const job of this.jobs.values()) {
        if (
          !job.isWorking &&
          !job.hasLease &&
          performance.now() - job.settledAt >= SYNC_LIMITS.snapshotLifetimeMs
        ) {
          if (await this.clean(job)) {
            this.jobs.delete(job.id)
          }
        }
      }
    } catch {
      /* 过期资源保留引用，用户可显式重试释放。 */
    } finally {
      this.isExpiring = false
    }
  }
  async stop(): Promise<void> {
    this.isStopped = true
    clearInterval(this.timer)
    for (const job of this.jobs.values()) {
      if (job.isWorking) {
        job.controller.abort(new ArchiveCancelledError())
      }
    }
    await Promise.all([...this.jobs.values()].flatMap((job) => (job.worker ? [job.worker] : [])))
    await this.expiration
    for (const job of this.jobs.values()) {
      if (!(await this.clean(job))) {
        throw new HttpOperationError('cleanup-failed', '恢复资源尚未完整释放。')
      }
    }
    this.jobs.clear()
  }
}
const BATCH_LIMITS_PER_PROCESS = 4096
