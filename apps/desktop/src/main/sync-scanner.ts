import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  BATCH_LIMITS,
  SYNC_LIMITS,
  SYNC_SCHEMA_VERSION,
  compareSyncPaths,
  isOpaqueId,
  isSyncPath,
  isSyncSnapshot,
  isWriteCandidateName,
} from '@savedata-sync/shared'
import type {
  DirectoryListing,
  EntryMetadata,
  SyncEntry,
  SyncScanState,
  SyncSnapshot,
} from '@savedata-sync/shared'
import type { WindowsDirectoryAdapter } from './directory-adapter.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 扫描用到的只读目录操作。 */
export type WindowsScanSource = Pick<WindowsDirectoryAdapter, 'deviceId' | 'listDirectory'>

/** 扫描选项：收紧上限。 */
export interface WindowsScanOptions {
  readonly maxEntries?: number
  readonly timeoutMs?: number
  readonly retentionMs?: number
}

interface ScanJob {
  readonly scanId: string
  readonly rootId: string
  readonly startedAt: number
  readonly controller: AbortController
  readonly entries: SyncEntry[]
  readonly timeout: ReturnType<typeof setTimeout>
  state: SyncScanState
  worker: Promise<void> | null
  expiry: ReturnType<typeof setTimeout> | null
  hasCancelled: boolean
}

// 写入途中进程被结束时，候选文件会留在目标文件旁边。扫描跳过它们，避免残留被比较和复制到另一台设备。
// 残留不在这里删除：进程结束后无法确认它属于本应用。
function savedEntries(value: DirectoryListing): EntryMetadata[] {
  return value.entries.filter((entry) => entry.kind !== 'file' || !isWriteCandidateName(entry.name))
}

function listingKey(value: DirectoryListing): string {
  return JSON.stringify(
    savedEntries(value)
      .map((entry) => [entry.entryId, entry.name, entry.kind, entry.sizeBytes, entry.modifiedAt])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)),
  )
}

/**
 * 当前会话内的异步只读扫描，只读取目录列表里的类型、大小和修改日期，目录大小为 null。
 * 同一时间只有一个扫描；完成的结果到期清除。
 */
export class WindowsSyncScanner {
  private readonly source: WindowsScanSource
  private readonly jobs = new Map<string, ScanJob>()
  private readonly maxEntries: number
  private readonly timeoutMs: number
  private readonly retentionMs: number
  private active: ScanJob | null = null
  private isClosed = false

  constructor(source: WindowsScanSource, options: WindowsScanOptions = {}) {
    this.source = source
    this.maxEntries = options.maxEntries ?? SYNC_LIMITS.maxEntries
    this.timeoutMs = options.timeoutMs ?? SYNC_LIMITS.scanTimeoutMs
    this.retentionMs = options.retentionMs ?? SYNC_LIMITS.snapshotLifetimeMs
    for (const [value, maximum] of [
      [this.maxEntries, SYNC_LIMITS.maxEntries],
      [this.timeoutMs, SYNC_LIMITS.scanTimeoutMs],
      [this.retentionMs, SYNC_LIMITS.snapshotLifetimeMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new HttpOperationError('invalid-request', 'The scan budget is invalid.')
      }
    }
  }

  /** 登记扫描任务并立即返回，随后在后台读取；根目录无效时错误记在扫描状态里。 */
  start(rootId: string): SyncScanState {
    if (!isOpaqueId(rootId)) {
      throw new HttpOperationError('invalid-request', 'The scan directory reference is invalid.')
    }
    if (this.isClosed || this.active) {
      throw new HttpOperationError('busy', 'The scanner stopped or another scan is running.')
    }
    if (this.jobs.size >= SYNC_LIMITS.maxRetainedScans) {
      this.evictOldest()
    }
    const scanId = randomUUID()
    const controller = new AbortController()
    const job: ScanJob = {
      scanId,
      rootId,
      controller,
      startedAt: performance.now(),
      entries: [],
      timeout: setTimeout(
        () => controller.abort(new HttpOperationError('timeout', 'The current scan timed out.')),
        this.timeoutMs,
      ),
      state: {
        schemaVersion: SYNC_SCHEMA_VERSION,
        scanId,
        rootId,
        status: 'running',
        scannedEntries: 0,
        snapshot: null,
        error: null,
      },
      worker: null,
      expiry: null,
      hasCancelled: false,
    }
    job.timeout.unref()
    this.jobs.set(scanId, job)
    this.active = job
    job.worker = this.run(job)
    return structuredClone(job.state)
  }

  /** 返回本实例的扫描状态；已到期或属于其他会话的 ID 需要重新扫描。 */
  get(scanId: string): SyncScanState {
    return structuredClone(this.find(scanId).state)
  }

  /** 等待这次扫描结束；等待不延长结果保留期。 */
  async wait(scanId: string): Promise<SyncScanState> {
    this.get(scanId)
    await this.jobs.get(scanId)?.worker
    return this.get(scanId)
  }

  /** 取消当前扫描；扫描线程释放文件后状态才是最终状态。 */
  cancel(scanId: string): SyncScanState {
    const job = this.find(scanId)
    if (job.state.status === 'running') {
      job.hasCancelled = true
      job.controller.abort(new HttpOperationError('io-failure', 'The scan was cancelled.'))
    }
    return structuredClone(job.state)
  }

  /** 停止接受扫描，取消并等待进行中的读取；之后移除全部临时结果。 */
  async stop(): Promise<void> {
    this.isClosed = true
    if (this.active) {
      this.cancel(this.active.scanId)
      await this.active?.worker
    }
    for (const job of this.jobs.values()) {
      clearTimeout(job.timeout)
      if (job.expiry) {
        clearTimeout(job.expiry)
      }
    }
    this.jobs.clear()
  }

  // 调用时没有活动扫描，最旧的一定已结束；只有最新一次比较的结果才可能被确认，丢掉旧的不影响确认。
  /** 结果数量到上限时丢掉最旧的结果。 */
  private evictOldest(): void {
    const [oldest] = this.jobs.values()
    if (oldest) {
      clearTimeout(oldest.expiry ?? undefined)
      this.jobs.delete(oldest.scanId)
    }
  }

  private find(scanId: string): ScanJob {
    if (!isOpaqueId(scanId)) {
      throw new HttpOperationError('invalid-request', 'The scan reference is invalid.')
    }
    const job = this.jobs.get(scanId)
    if (!job) {
      throw new HttpOperationError('not-found', 'The scan does not exist or expired. Scan again.')
    }
    return job
  }

  private check(job: ScanJob): void {
    if (job.controller.signal.aborted) {
      throw job.controller.signal.reason
    }
    if (performance.now() - job.startedAt >= this.timeoutMs) {
      throw new HttpOperationError('timeout', 'The current scan timed out.')
    }
  }

  private snapshot(job: ScanJob, error: SyncSnapshot['error']): SyncSnapshot {
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      scanId: job.scanId,
      deviceId: this.source.deviceId,
      rootId: job.rootId,
      observedAt: Date.now(),
      entries: [...job.entries].sort((a, b) => compareSyncPaths(a.path, b.path)),
      error,
    }
  }

  private async run(job: ScanJob): Promise<void> {
    try {
      await this.visit(job, null, [])
      this.check(job)
      const snapshot = this.snapshot(job, null)
      if (!isSyncSnapshot(snapshot)) {
        throw new HttpOperationError('io-failure', 'The scan result format is invalid.')
      }
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > BATCH_LIMITS.maxJsonBytes - 4096) {
        throw new HttpOperationError('resource-limit', 'The scan manifest exceeds transfer limits.')
      }
      job.state = { ...job.state, status: 'succeeded', snapshot }
    } catch (cause) {
      if (job.hasCancelled) {
        job.state = { ...job.state, status: 'cancelled' }
      } else {
        const error = toHttpError(cause).operationError
        const snapshot = this.snapshot(job, error)
        // 失败也要能通过控制响应返回；保留进度计数，用根级错误表示未完成。
        job.state = {
          ...job.state,
          status: 'failed',
          error,
          snapshot:
            Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= BATCH_LIMITS.maxJsonBytes - 4096
              ? snapshot
              : { ...snapshot, entries: [] },
        }
      }
    } finally {
      clearTimeout(job.timeout)
      this.active = null
      job.expiry = setTimeout(() => this.jobs.delete(job.scanId), this.retentionMs)
      job.expiry.unref()
    }
  }

  private async visit(
    job: ScanJob,
    parentId: string | null,
    parentPath: readonly string[],
  ): Promise<void> {
    this.check(job)
    const before = await this.source.listDirectory(job.rootId, parentId)
    if (before.status === 'error') {
      throw new HttpOperationError(before.error.code, before.error.message)
    }
    this.check(job)
    for (const entry of savedEntries(before.value).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      this.check(job)
      const path = [...parentPath, entry.name]
      if (!isSyncPath(path) || job.entries.length >= this.maxEntries) {
        throw new HttpOperationError(
          'resource-limit',
          'Scan entries, names, or directory depth exceed the limit.',
        )
      }
      const index = job.entries.length
      job.entries.push({
        entryId: entry.entryId,
        path,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
        error: null,
      })
      job.state = { ...job.state, scannedEntries: job.entries.length }
      if (entry.kind === 'directory') {
        try {
          await this.visit(job, entry.entryId, path)
        } catch (cause) {
          const previous = job.entries[index]
          if (previous) {
            job.entries[index] = { ...previous, error: toHttpError(cause).operationError }
          }
          throw cause
        }
      }
    }
    const after = await this.source.listDirectory(job.rootId, parentId)
    this.check(job)
    if (after.status === 'error') {
      throw new HttpOperationError(after.error.code, after.error.message)
    }
    if (listingKey(before.value) !== listingKey(after.value)) {
      throw new HttpOperationError(
        'source-changed',
        'The directory changed during the scan. Scan again.',
      )
    }
  }
}
