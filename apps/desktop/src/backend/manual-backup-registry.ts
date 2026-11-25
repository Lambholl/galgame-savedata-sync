import { randomUUID } from 'node:crypto'
import {
  BATCH_LIMITS,
  BATCH_TIMEOUTS_MS,
  SYNC_LIMITS,
  SYNC_SCHEMA_VERSION,
  isOpaqueId,
} from '@savedata-sync/shared'
import type { OperationError, SyncManualBackupState } from '@savedata-sync/shared'
import { ArchiveCancelledError, ArchiveError, checkArchiveAbort } from './archive-errors.ts'
import type { DesktopBackupStore } from './backup-store.ts'
import type { DesktopDirectoryAdapter } from './directory-adapter.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'
import type { DesktopLibrary } from './library-store.ts'
import { DesktopSyncScanner } from './sync-scanner.ts'
import { acquireTargetOperation, releaseTargetOperation } from './target-operation.ts'

interface ManualBackupJob {
  readonly id: string
  readonly token: symbol
  readonly projectId: string
  readonly rootId: string
  readonly controller: AbortController
  state: SyncManualBackupState
  worker: Promise<void> | null
  timeout: ReturnType<typeof setTimeout> | null
  settledAt: number | null
  hasTimedOut: boolean
}

/** 创建本机手动备份管理器所需的依赖。 */
export interface DesktopManualBackupOptions {
  readonly source: DesktopDirectoryAdapter
  readonly backups: DesktopBackupStore
  readonly library: Pick<DesktopLibrary, 'snapshot'>
}

/**
 * 本机手动备份的异步任务管理器。
 * 开始时占用 TargetOperation 名额，扫描当前存档目录并提交手动备份，结束后按 BATCH_TIMEOUTS_MS.terminalRetention 保留终态供查询。
 */
export class DesktopManualBackupRegistry {
  private readonly options: DesktopManualBackupOptions
  private readonly jobs = new Map<string, ManualBackupJob>()
  private active: ManualBackupJob | null = null
  private isStopped = false

  constructor(options: DesktopManualBackupOptions) {
    this.options = options
  }

  /**
   * 立即为指定游戏启动一次本机手动备份；目标名额被占用或管理器正在停止时抛 busy，游戏引用无效或未配置本机目录时抛 invalid-request。
   */
  start(projectId: string): SyncManualBackupState {
    if (!isOpaqueId(projectId)) {
      throw new HttpOperationError('invalid-request', 'The game reference is invalid.')
    }
    if (this.isStopped) {
      throw new HttpOperationError('busy', 'The manual backup manager is stopping.')
    }
    this.purge()
    const game = this.options.library.snapshot().config.games.find((item) => item.id === projectId)
    if (!game?.rootId) {
      throw new HttpOperationError(
        'invalid-request',
        "Configure this game's local directory first.",
      )
    }
    const token = Symbol('manual-backup')
    acquireTargetOperation(token)
    if (this.jobs.size >= SYNC_LIMITS.maxRetainedScans) {
      this.evictOldest()
    }
    const id = randomUUID()
    const controller = new AbortController()
    const job: ManualBackupJob = {
      id,
      token,
      projectId,
      rootId: game.rootId,
      controller,
      state: {
        schemaVersion: SYNC_SCHEMA_VERSION,
        taskId: id,
        projectId,
        rootId: game.rootId,
        status: 'running',
        stage: 'scanning',
        updatedAt: Date.now(),
        isCancelRequested: false,
        bytesCopied: 0,
        totalBytes: 0,
        backupId: null,
        fileCount: null,
        error: null,
        cleanupError: null,
      },
      worker: null,
      timeout: null,
      settledAt: null,
      hasTimedOut: false,
    }
    job.timeout = setTimeout(() => {
      job.hasTimedOut = true
      job.controller.abort(
        new HttpOperationError('timeout', 'The manual backup operation timed out.'),
      )
    }, BATCH_TIMEOUTS_MS.total)
    job.timeout.unref()
    this.jobs.set(id, job)
    this.active = job
    job.worker = this.run(job)
    return structuredClone(job.state)
  }

  /** 返回当前正在运行的手动备份状态；没有运行中的任务时返回 null。 */
  current(): SyncManualBackupState | null {
    this.purge()
    return this.active ? structuredClone(this.active.state) : null
  }

  /** 按 taskId 读取手动备份状态；任务不存在或已过期时抛 not-found。 */
  state(taskId: string): SyncManualBackupState {
    this.purge()
    return structuredClone(this.find(taskId).state)
  }

  /** 请求取消指定的手动备份；已结束的任务原样返回终态，不存在时抛 not-found。 */
  cancel(taskId: string): SyncManualBackupState {
    this.purge()
    const job = this.find(taskId)
    if (job.state.status === 'running') {
      job.state = { ...job.state, isCancelRequested: true, updatedAt: Date.now() }
      job.controller.abort(new ArchiveCancelledError())
    }
    return structuredClone(job.state)
  }

  /** 判断当前是否有正在运行的手动备份任务。 */
  hasRunningWork(): boolean {
    return this.active !== null
  }

  /** 停止接纳新任务，取消并等待正在运行的手动备份退出与释放名额。 */
  async stop(): Promise<void> {
    this.isStopped = true
    const current = this.active
    if (current) {
      current.state = { ...current.state, isCancelRequested: true, updatedAt: Date.now() }
      current.controller.abort(new ArchiveCancelledError())
      await current.worker
    }
    for (const job of this.jobs.values()) {
      if (job.timeout) {
        clearTimeout(job.timeout)
      }
    }
    this.jobs.clear()
  }

  private find(taskId: string): ManualBackupJob {
    const job = this.jobs.get(taskId)
    if (!isOpaqueId(taskId) || !job) {
      throw new HttpOperationError('not-found', 'The manual backup task does not exist or expired.')
    }
    return job
  }

  private verifyProject(job: ManualBackupJob): void {
    const game = this.options.library
      .snapshot()
      .config.games.find((item) => item.id === job.projectId)
    if (!game || game.rootId !== job.rootId) {
      throw new HttpOperationError(
        'permission-denied',
        'The game directory changed during backup. Try again.',
      )
    }
  }

  private purge(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (
        job !== this.active &&
        job.settledAt !== null &&
        now - job.settledAt >= BATCH_TIMEOUTS_MS.terminalRetention
      ) {
        this.jobs.delete(id)
      }
    }
  }

  private evictOldest(): void {
    for (const [id, job] of this.jobs) {
      if (job !== this.active) {
        this.jobs.delete(id)
        return
      }
    }
  }

  private async run(job: ManualBackupJob): Promise<void> {
    const scanner = new DesktopSyncScanner(this.options.source)
    let scanId: string | null = null
    const abortScan = (): void => {
      if (scanId) {
        try {
          scanner.cancel(scanId)
        } catch {
          /* 扫描已结束或已清理时无需再取消。 */
        }
      }
    }
    job.controller.signal.addEventListener('abort', abortScan, { once: true })
    try {
      checkArchiveAbort(job.controller.signal)
      this.verifyProject(job)
      const started = scanner.start(job.rootId)
      scanId = started.scanId
      if (job.controller.signal.aborted) {
        abortScan()
      }
      const scanned = await scanner.wait(started.scanId)
      checkArchiveAbort(job.controller.signal)
      if (scanned.status === 'cancelled') {
        throw new ArchiveCancelledError()
      }
      if (scanned.status !== 'succeeded' || !scanned.snapshot) {
        const failure = scanned.error
        throw new HttpOperationError(
          failure?.code ?? 'io-failure',
          failure?.message ?? 'Could not scan the local save folder.',
        )
      }
      this.verifyProject(job)
      let fileCount = 0
      let totalBytes = 0
      for (const entry of scanned.snapshot.entries) {
        if (entry.kind !== 'file') {
          continue
        }
        if (entry.sizeBytes === null) {
          throw new HttpOperationError(
            'invalid-request',
            'A file to be backed up has an unknown size.',
          )
        }
        if (entry.sizeBytes > BATCH_LIMITS.maxFileBytes) {
          throw new HttpOperationError(
            'resource-limit',
            'A file to be backed up exceeds the size limit.',
          )
        }
        fileCount += 1
        totalBytes += entry.sizeBytes
      }
      if (fileCount === 0) {
        job.state = {
          ...job.state,
          status: 'empty',
          stage: 'done',
          updatedAt: Date.now(),
          bytesCopied: 0,
          totalBytes: 0,
          backupId: null,
          fileCount: null,
          error: null,
          cleanupError: null,
        }
        return
      }
      if (fileCount > BATCH_LIMITS.maxFiles || totalBytes > BATCH_LIMITS.maxTotalFileBytes) {
        throw new HttpOperationError(
          'resource-limit',
          'The backup exceeds file count or total size limits.',
        )
      }
      job.state = {
        ...job.state,
        stage: 'backing-up',
        updatedAt: Date.now(),
        bytesCopied: 0,
        totalBytes,
      }
      const commit = await this.options.backups.createManual(job.projectId, scanned.snapshot, {
        signal: job.controller.signal,
        onProgress: (bytesCopied) => {
          if (job.state.status === 'running') {
            job.state = {
              ...job.state,
              bytesCopied: Math.min(bytesCopied, totalBytes),
              updatedAt: Date.now(),
            }
          }
        },
      })
      if (!commit.manifest) {
        job.state = {
          ...job.state,
          status: 'empty',
          stage: 'done',
          updatedAt: Date.now(),
          bytesCopied: 0,
          totalBytes: 0,
          backupId: null,
          fileCount: null,
          error: null,
          cleanupError: null,
        }
        return
      }
      job.state = {
        ...job.state,
        status: 'succeeded',
        stage: 'done',
        updatedAt: Date.now(),
        bytesCopied: totalBytes,
        totalBytes,
        backupId: commit.manifest.backupId,
        fileCount: commit.manifest.files.length,
        error: null,
        cleanupError: commit.cleanupError,
      }
    } catch (cause) {
      const cleanupError: OperationError | null =
        cause instanceof ArchiveError ? cause.cleanupError : null
      const isCancelled =
        !job.hasTimedOut && (cause instanceof ArchiveCancelledError || job.state.isCancelRequested)
      if (isCancelled) {
        job.state = {
          ...job.state,
          status: 'cancelled',
          stage: 'done',
          updatedAt: Date.now(),
          isCancelRequested: true,
          backupId: null,
          fileCount: null,
          error: null,
          cleanupError,
        }
      } else {
        const error: OperationError = job.hasTimedOut
          ? { code: 'timeout', message: 'The manual backup operation timed out.', canRetry: false }
          : toHttpError(cause).operationError
        job.state = {
          ...job.state,
          status: 'failed',
          stage: 'done',
          updatedAt: Date.now(),
          backupId: null,
          fileCount: null,
          error,
          cleanupError,
        }
      }
    } finally {
      job.controller.signal.removeEventListener('abort', abortScan)
      if (job.timeout) {
        clearTimeout(job.timeout)
        job.timeout = null
      }
      await scanner.stop().catch(() => {
        /* 局部扫描器只持有内存句柄，停止失败不影响释放名额。 */
      })
      job.settledAt = Date.now()
      if (this.active === job) {
        this.active = null
      }
      releaseTargetOperation(job.token)
    }
  }
}
