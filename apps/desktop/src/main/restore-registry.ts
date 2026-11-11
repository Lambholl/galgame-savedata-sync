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
    message: 'This restore still has resources or backups awaiting cleanup. Retry cleanup.',
    canRetry: false,
  }
}

/** 本机恢复任务的登记表。准备阶段不占用写入名额。 */
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
        'The game directory changed. Read the backup and current directory again.',
      )
    }
  }
  private find(id: string): RestoreJob {
    const job = this.jobs.get(id)
    if (!isOpaqueId(id) || !job) {
      throw new HttpOperationError(
        'not-found',
        'This restore was released or expired. Read the backup again.',
      )
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
      job.controller.abort(
        new HttpOperationError('timeout', 'This restore operation timed out. Scan again.'),
      )
    }, BATCH_TIMEOUTS_MS.total)
    job.timeout.unref()
  }
  /** 列出恢复任务的摘要。 */
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
  /** 读取恢复任务的状态；任务不存在时抛错。 */
  state(id: string): DesktopRestoreState {
    const job = this.find(id)
    return structuredClone({ ...job.state, isWorking: job.isWorking })
  }
  /** 读取恢复计划；计划还没生成时抛出 task-conflict 错误。 */
  preview(id: string): SyncPlan {
    const job = this.find(id)
    if (!job.plan) {
      throw new HttpOperationError('task-conflict', 'The current restore preview is not ready yet.')
    }
    return structuredClone(job.plan)
  }
  /** 创建恢复任务并立即返回，随后在后台扫描目标并校验备份。 */
  prepare(projectId: string, rootId: string, backupId: string): DesktopRestoreState {
    if (![projectId, rootId, backupId].every(isOpaqueId)) {
      throw new HttpOperationError('invalid-request', 'The restore reference is invalid.')
    }
    if (this.isStopped || [...this.jobs.values()].some((job) => job.isWorking)) {
      throw new HttpOperationError('busy', 'The previous restore operation has not finished.')
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
      throw new HttpOperationError(
        'resource-limit',
        'The restore preview limit has been reached. Release unused previews first.',
      )
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
          current.error?.message ?? 'The current directory scan is incomplete.',
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
  /** 按确认的计划开始恢复；计划必须与 preview 返回的相同，重复确认时抛错。 */
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
      throw new HttpOperationError(
        'task-conflict',
        'The restore preview was used, has resources awaiting cleanup, or is not ready yet.',
      )
    }
    if (performance.now() - job.settledAt >= SYNC_LIMITS.snapshotLifetimeMs) {
      throw new HttpOperationError('not-found', 'The restore preview expired. Scan again.')
    }
    if (
      !job.plan.canExecute ||
      !matchesSyncPlan(value, {
        planId: job.plan.planId,
        projectId: job.plan.projectId,
        operation: job.plan.operation,
        direction: job.plan.direction,
        shouldBackup: job.plan.shouldBackup,
        shouldDeleteExtras: job.plan.shouldDeleteExtras,
        source: job.plan.source,
        target: job.plan.target,
      })
    ) {
      throw new HttpOperationError(
        'invalid-request',
        'The confirmed plan differs from the native preview or contains conflicts.',
      )
    }
    if (this.confirmed >= BATCH_LIMITS_PER_PROCESS) {
      throw new HttpOperationError(
        'resource-limit',
        'The restore confirmation limit for this process has been reached.',
      )
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
        throw new HttpOperationError('task-conflict', 'This restore material was released.')
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
        new HttpOperationError('timeout', 'This restore timed out.'),
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
              ? new HttpOperationError('timeout', 'This restore operation timed out. Scan again.')
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
          throw new HttpOperationError(
            'cleanup-failed',
            'Inspect and clean up incomplete backups on the backup page first.',
          )
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
  /** 取消恢复任务；还没开始写入的任务直接结束并清理。 */
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
  /** 重试恢复任务的清理；任务还在运行时抛出 busy 错误。 */
  async retryCleanup(id: string): Promise<DesktopRestoreState> {
    const job = this.find(id)
    if (job.isWorking) {
      throw new HttpOperationError('busy', 'The restore operation has not finished.')
    }
    await this.clean(job)
    this.touch(job)
    return this.state(id)
  }
  /** 清理并移除已结束的恢复任务；任务还在运行时抛出 busy，清理失败时抛出 cleanup-failed。 */
  async release(id: string): Promise<void> {
    const job = this.find(id)
    if (job.isWorking) {
      throw new HttpOperationError('busy', 'The restore operation has not finished.')
    }
    if (!(await this.clean(job))) {
      throw new HttpOperationError(
        'cleanup-failed',
        'Restore material has not been released. Retry cleanup.',
      )
    }
    this.jobs.delete(id)
  }
  /** 判断是否有正在运行的恢复任务。 */
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
      /* 清理失败的任务保留，可以手动重试释放。 */
    } finally {
      this.isExpiring = false
    }
  }
  /** 停止登记表：取消进行中的任务，等待它们结束并清理。 */
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
        throw new HttpOperationError(
          'cleanup-failed',
          'Restore resources have not been fully released.',
        )
      }
    }
    this.jobs.clear()
  }
}
const BATCH_LIMITS_PER_PROCESS = 4096
