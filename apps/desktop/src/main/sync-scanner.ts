import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { finished } from 'node:stream/promises'
import {
  BATCH_LIMITS,
  SYNC_LIMITS,
  SYNC_SCHEMA_VERSION,
  compareSyncPaths,
  isOpaqueId,
  isSyncPath,
  isSyncSnapshot,
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

/** 只读依赖；不接受 Renderer 路径或写入入口。 */
export type WindowsScanSource = Pick<
  WindowsDirectoryAdapter,
  'deviceId' | 'listDirectory' | 'openFile'
>

/** 原生验证可收紧限制，网络请求不能修改扫描预算。 */
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

function listingKey(value: DirectoryListing): string {
  return JSON.stringify(
    value.entries
      .map((entry) => [entry.entryId, entry.name, entry.kind, entry.sizeBytes, entry.modifiedAt])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)),
  )
}

/**
 * 会话内异步只读扫描，真实哈希在 Node 流中计算，目录大小保持 null。
 * 一次仅一个扫描；查询只复制公开快照，取消/stop 等待 worker 关闭文件流。
 * 已完成结果到期清除，不持久化历史索引；用法见桌面 README 的扫描接口。
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
        throw new HttpOperationError('invalid-request', '扫描预算无效。')
      }
    }
  }

  /** 先登记任务再异步读取，非法根由原生适配器返回具体错误。 */
  start(rootId: string): SyncScanState {
    if (!isOpaqueId(rootId)) {
      throw new HttpOperationError('invalid-request', '扫描目录引用无效。')
    }
    if (this.isClosed || this.active) {
      throw new HttpOperationError('busy', '扫描器已停止或已有扫描正在进行。')
    }
    if (this.jobs.size >= SYNC_LIMITS.maxRetainedScans) {
      throw new HttpOperationError('resource-limit', '扫描结果数量已达上限，请稍后重新扫描。')
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
        () => controller.abort(new HttpOperationError('timeout', '当前扫描超时。')),
        this.timeoutMs,
      ),
      state: {
        schemaVersion: SYNC_SCHEMA_VERSION,
        scanId,
        rootId,
        status: 'running',
        scannedEntries: 0,
        bytesRead: 0,
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

  /** 只返回本实例的句柄；到期/其他会话 ID 要求重新扫描。 */
  get(scanId: string): SyncScanState {
    return structuredClone(this.find(scanId).state)
  }

  /** 取消仅终止当前只读扫描，最终状态在 worker 释放流后给出。 */
  cancel(scanId: string): SyncScanState {
    const job = this.find(scanId)
    if (job.state.status === 'running') {
      job.hasCancelled = true
      job.controller.abort(new HttpOperationError('io-failure', '扫描已取消。'))
    }
    return structuredClone(job.state)
  }

  /** 关闭接纳，取消并等待活动读取；会话结束后移除全部临时结果。 */
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

  private find(scanId: string): ScanJob {
    if (!isOpaqueId(scanId)) {
      throw new HttpOperationError('invalid-request', '扫描引用无效。')
    }
    const job = this.jobs.get(scanId)
    if (!job) {
      throw new HttpOperationError('not-found', '扫描不存在或已过期，请重新扫描。')
    }
    return job
  }

  private check(job: ScanJob): void {
    if (job.controller.signal.aborted) {
      throw job.controller.signal.reason
    }
    if (performance.now() - job.startedAt >= this.timeoutMs) {
      throw new HttpOperationError('timeout', '当前扫描超时。')
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
        throw new HttpOperationError('io-failure', '扫描结果格式无效。')
      }
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > BATCH_LIMITS.maxJsonBytes - 4096) {
        throw new HttpOperationError('resource-limit', '扫描清单超过传输限制。')
      }
      job.state = { ...job.state, status: 'succeeded', snapshot }
    } catch (cause) {
      if (job.hasCancelled) {
        job.state = { ...job.state, status: 'cancelled' }
      } else {
        const error = toHttpError(cause).operationError
        const snapshot = this.snapshot(job, error)
        // 失败仍须能通过控制响应返回；保留进度计数，以根级错误表示未完成。
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
    for (const entry of [...before.value.entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      this.check(job)
      const path = [...parentPath, entry.name]
      if (!isSyncPath(path) || job.entries.length >= this.maxEntries) {
        throw new HttpOperationError('resource-limit', '扫描条目、名称或目录深度超过限制。')
      }
      const index = job.entries.length
      job.entries.push({
        entryId: entry.entryId,
        path,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
        sha256: null,
        error: null,
      })
      job.state = { ...job.state, scannedEntries: job.entries.length }
      try {
        if (entry.kind === 'directory') {
          await this.visit(job, entry.entryId, path)
        } else {
          const file = await this.hash(job, entry)
          job.entries[index] = { ...file, path }
        }
      } catch (cause) {
        const previous = job.entries[index]
        if (previous) {
          job.entries[index] = { ...previous, error: toHttpError(cause).operationError }
        }
        throw cause
      }
    }
    const after = await this.source.listDirectory(job.rootId, parentId)
    this.check(job)
    if (after.status === 'error') {
      throw new HttpOperationError(after.error.code, after.error.message)
    }
    if (listingKey(before.value) !== listingKey(after.value)) {
      throw new HttpOperationError('source-changed', '目录在扫描期间变化，请重新扫描。')
    }
  }

  private async hash(job: ScanJob, entry: EntryMetadata): Promise<Omit<SyncEntry, 'path'>> {
    const opened = await this.source.openFile({ rootId: job.rootId, entryId: entry.entryId })
    if (opened.status === 'error') {
      throw new HttpOperationError(opened.error.code, opened.error.message)
    }
    const { stream, metadata, verifyUnchanged } = opened.value
    const abort = (): void => {
      stream.destroy(toHttpError(job.controller.signal.reason))
    }
    job.controller.signal.addEventListener('abort', abort, { once: true })
    let hasFailed = false
    try {
      this.check(job)
      if (
        metadata.name !== entry.name ||
        metadata.sizeBytes !== entry.sizeBytes ||
        metadata.modifiedAt !== entry.modifiedAt
      ) {
        throw new HttpOperationError('source-changed', '文件在扫描前变化，请重新扫描。')
      }
      const hash = createHash('sha256')
      let sizeBytes = 0
      for await (const chunk of stream as AsyncIterable<unknown>) {
        this.check(job)
        if (!Buffer.isBuffer(chunk)) {
          throw new HttpOperationError('io-failure', '文件读取流格式无效。')
        }
        sizeBytes += chunk.length
        const bytesRead = job.state.bytesRead + chunk.length
        if (!Number.isSafeInteger(sizeBytes) || !Number.isSafeInteger(bytesRead)) {
          throw new HttpOperationError('resource-limit', '读取字节数超过可表示范围。')
        }
        job.state = { ...job.state, bytesRead }
        hash.update(chunk)
      }
      await verifyUnchanged()
      this.check(job)
      if (metadata.sizeBytes !== null && metadata.sizeBytes !== sizeBytes) {
        throw new HttpOperationError('source-changed', '文件实测长度与当前属性不一致。')
      }
      return {
        entryId: entry.entryId,
        kind: 'file',
        sizeBytes,
        modifiedAt: metadata.modifiedAt,
        sha256: hash.digest('hex'),
        error: null,
      }
    } catch (cause) {
      hasFailed = true
      throw cause
    } finally {
      job.controller.signal.removeEventListener('abort', abort)
      stream.destroy()
      if (hasFailed) {
        await finished(stream).catch(() => {
          /* 主错误由扫描结果保存，等待文件流关闭。 */
        })
      } else {
        await finished(stream)
      }
    }
  }
}
