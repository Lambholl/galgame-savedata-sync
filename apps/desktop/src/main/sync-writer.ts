import { randomUUID } from 'node:crypto'
import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  SYNC_LIMITS,
  createSyncPlan,
  isSyncPlan,
  matchesSyncPlan,
  syncPathKey,
} from '@savedata-sync/shared'
import type {
  KnownOperationError,
  OperationError,
  SyncApplyResult,
  SyncEntry,
  SyncPlan,
  SyncPlanEntry,
  SyncSnapshot,
  SyncWriteOutcome,
} from '@savedata-sync/shared'
import type { NativeDirectoryLocation, WindowsDirectoryAdapter } from './directory-adapter.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { WindowsBackupHandle, WindowsBackupStore } from './backup-store.ts'
import {
  ArchiveCancelledError,
  ArchiveError,
  checkArchiveAbort,
  toArchiveError,
} from './archive-errors.ts'
import { hashBackupStream } from './backup-files.ts'
import { toPublicationError } from './publication-errors.ts'
import { WindowsSyncScanner } from './sync-scanner.ts'
import { acquireTargetOperation, releaseTargetOperation } from './target-operation.ts'
import {
  SYNC_TARGET_IO,
  checkTargetName,
  cleanupCandidate,
  createCandidate,
  stageCandidate,
  verifyTargetFile,
} from './sync-target-files.ts'
import type { SyncCandidate, SyncTargetIO } from './sync-target-files.ts'

/** 完整校验后的原生输入，可重复读取；快照必须与确认计划相符，流由 writer 关闭。 */
export interface WindowsSyncMaterial {
  readonly snapshot: SyncSnapshot
  readonly openFile: (
    entryId: string,
  ) => Promise<{ stream: Readable; verifyUnchanged: () => Promise<void> }>
}
/** authorize 每次核实本机项目/根授权；调用方应固定会话及对端配置，不接受路径参数。 */
export interface WindowsSyncWriterOptions {
  readonly authorize: (plan: SyncPlan) => void | Promise<void>
  readonly io?: Partial<SyncTargetIO>
  readonly timeoutMs?: number
}
/** 同步阶段通知仅作观察；回调错误不会打断已经完成的原生写入。 */
export interface WindowsSyncWriteOptions {
  readonly signal?: AbortSignal
  readonly onStage?: (
    stage: 'checking' | 'backing-up' | 'writing',
    path: readonly string[] | null,
  ) => void
}
/** 仅原生持有的恢复预览；apply/close 二选一，输入轮次在释放前保持引用。 */
export interface WindowsRestorePreparation {
  readonly plan: SyncPlan
  readonly apply: (options?: WindowsSyncWriteOptions) => Promise<SyncApplyResult>
  readonly close: () => Promise<void>
}
interface WriteJob {
  readonly token: symbol
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly plan: SyncPlan
  readonly locations: Map<string, NativeDirectoryLocation>
  readonly candidates: Set<SyncCandidate>
  readonly scanner: WindowsSyncScanner
  worker: Promise<SyncApplyResult> | null
  isRunning: boolean
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new ArchiveError('invalid-request', '确认计划缺少本次引用。')
  }
  return value
}
function fileEntry(plan: SyncPlan, operation: SyncPlanEntry, side: 'source' | 'target'): SyncEntry {
  const entry = required(
    plan[side].entries.find(
      (entry) =>
        entry.entryId === (side === 'source' ? operation.sourceEntryId : operation.targetEntryId),
    ),
  )
  if (entry.kind !== 'file' || entry.sizeBytes === null || entry.sha256 === null) {
    throw new ArchiveError('invalid-request', '文件缺少完整内容指纹。')
  }
  return entry
}
function failure(error: unknown, signal?: AbortSignal): ArchiveError | ArchiveCancelledError {
  const archive = toArchiveError(error, signal)
  return archive instanceof ArchiveCancelledError ||
    error instanceof ArchiveError ||
    signal?.aborted
    ? archive
    : new ArchiveError(
        toPublicationError(error).operationError.code,
        toPublicationError(error).operationError.message,
        error,
      )
}
function cleanupError(): KnownOperationError {
  return {
    code: 'cleanup-failed',
    message: '本次文件候选或恢复材料未完整释放，请核实后重试清理。',
    canRetry: false,
  }
}
function outcome(
  operation: SyncPlanEntry,
  status: SyncWriteOutcome['status'],
  error: OperationError | null = null,
  entry?: SyncEntry,
): SyncWriteOutcome {
  if (
    operation.action !== 'create-directory' &&
    operation.action !== 'create-file' &&
    operation.action !== 'replace-file'
  ) {
    throw new ArchiveError('invalid-request', '当前计划项没有写入动作。')
  }
  return {
    path: operation.path,
    action: operation.action,
    status,
    error,
    sizeBytes: status === 'succeeded' && entry ? entry.sizeBytes : null,
    sha256: status === 'succeeded' && entry ? entry.sha256 : null,
  }
}

/**
 * 已确认计划的原生目标执行器：整批复核/备份后按文件发布，结果只表示实际观察。
 * 与旧批次共用互斥；输入/流/候选均不跨 IPC。失败清理保留名额，retryCleanup 显式释放。
 * 本机恢复入口和调用示例见桌面 README；网络登记与界面由独立编排接入。
 */
export class WindowsSyncWriter {
  private readonly io: SyncTargetIO
  private readonly timeoutMs: number
  private readonly usedIds = new Set<string>()
  private readonly preparations = new Set<WindowsBackupHandle>()
  private job: WriteJob | null = null
  private isStopped = false
  constructor(
    private readonly source: WindowsDirectoryAdapter,
    private readonly backups: WindowsBackupStore,
    private readonly options: WindowsSyncWriterOptions,
  ) {
    this.io = { ...SYNC_TARGET_IO, ...options.io }
    this.timeoutMs = options.timeoutMs ?? SYNC_LIMITS.scanTimeoutMs
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > SYNC_LIMITS.scanTimeoutMs
    ) {
      throw new ArchiveError('invalid-request', '目标写入期限无效。')
    }
  }
  /** 非法/过期/重复确认及 busy 拒绝；已接纳任务的失败/取消返回完整逐项结果。 */
  apply(
    value: SyncPlan,
    material: WindowsSyncMaterial | null,
    options: WindowsSyncWriteOptions = {},
  ): Promise<SyncApplyResult> {
    if (
      !isSyncPlan(value) ||
      !value.canExecute ||
      value.target.deviceId !== this.source.deviceId ||
      !['android-to-windows', 'local-restore'].includes(value.direction) ||
      (material &&
        !matchesSyncPlan(value, {
          planId: value.planId,
          projectId: value.projectId,
          operation: value.operation,
          direction: value.direction,
          shouldBackup: value.shouldBackup,
          source: material.snapshot,
          target: value.target,
        })) ||
      (value.transferFileCount > 0 && !material)
    ) {
      throw new ArchiveError('invalid-request', '目标或原生材料与完整确认计划不符。')
    }
    if (this.isStopped || this.job) {
      throw new ArchiveError('busy', '写入器已停止或资源仍待清理。')
    }
    if (this.usedIds.has(value.planId)) {
      throw new ArchiveError('task-conflict', '本次确认已经使用，请重新扫描。')
    }
    if (this.usedIds.size >= 4096) {
      throw new ArchiveError('resource-limit', '本进程确认标识容量已满。')
    }
    const now = Date.now()
    if (
      (value.operation === 'restore' ? [value.source, value.target] : [value.target]).some(
        (snapshot) =>
          snapshot.observedAt > now || now - snapshot.observedAt > SYNC_LIMITS.snapshotLifetimeMs,
      )
    ) {
      throw new ArchiveError('not-found', '本机扫描或恢复预览已过期，请重新扫描。')
    }
    const token = Symbol('sync-write')
    acquireTargetOperation(token)
    const controller = new AbortController()
    const job: WriteJob = {
      token,
      controller,
      plan: structuredClone(value),
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.timeoutMs),
        ...(options.signal ? [options.signal] : []),
      ]),
      locations: new Map(),
      candidates: new Set(),
      scanner: new WindowsSyncScanner(this.source),
      worker: null,
      isRunning: true,
    }
    this.job = job
    this.usedIds.add(value.planId)
    job.worker = this.run(job, material, options)
    return job.worker
  }
  private emit(
    options: WindowsSyncWriteOptions,
    stage: 'checking' | 'backing-up' | 'writing',
    path: readonly string[] | null = null,
  ): void {
    try {
      options.onStage?.(stage, path ? [...path] : null)
    } catch {
      /* 观察者失败不改变任务实际结果。 */
    }
  }
  private async check(job: WriteJob): Promise<void> {
    checkArchiveAbort(job.signal)
    await this.options.authorize(structuredClone(job.plan))
    checkArchiveAbort(job.signal)
    await required(job.locations.get(syncPathKey([]))).verify()
  }
  private async preflight(job: WriteJob, material: WindowsSyncMaterial | null): Promise<void> {
    await this.options.authorize(structuredClone(job.plan))
    checkArchiveAbort(job.signal)
    const root = await this.source.locateNativeDirectory(job.plan.target.rootId)
    job.locations.set(syncPathKey([]), root)
    await access(root.path, constants.W_OK)
    const scan = job.scanner.start(job.plan.target.rootId)
    const abort = (): void => {
      job.scanner.cancel(scan.scanId)
    }
    job.signal.addEventListener('abort', abort, { once: true })
    try {
      if (job.signal.aborted) {
        abort()
      }
      const state = await job.scanner.wait(scan.scanId)
      checkArchiveAbort(job.signal)
      if (state.status !== 'succeeded' || !state.snapshot) {
        throw new ArchiveError(
          state.error?.code === 'result-unknown'
            ? 'io-failure'
            : (state.error?.code ?? 'io-failure'),
          state.error?.message ?? '目标复核扫描未完成。',
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
      if (entries(state.snapshot) !== entries(job.plan.target)) {
        throw new ArchiveError('source-changed', '目标内容与确认时不同，请重新扫描。')
      }
      for (const entry of state.snapshot.entries) {
        if (entry.kind === 'directory') {
          job.locations.set(
            syncPathKey(entry.path),
            await this.source.locateNativeDirectory(job.plan.target.rootId, entry.entryId),
          )
        }
      }
    } finally {
      job.signal.removeEventListener('abort', abort)
    }
    // 完整输入在任何目录修改前全部重读；逐文件写入还会再次复核。
    for (const operation of job.plan.entries) {
      if (operation.action === 'create-file' || operation.action === 'replace-file') {
        checkArchiveAbort(job.signal)
        const entry = fileEntry(job.plan, operation, 'source')
        const input = await required(material).openFile(entry.entryId)
        try {
          const actual = await hashBackupStream(input.stream, entry.sizeBytes ?? -1, job.signal)
          await input.verifyUnchanged()
          if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
            throw new ArchiveError('checksum-mismatch', '完整输入与确认计划不同。')
          }
        } finally {
          input.stream.destroy()
          await finished(input.stream).catch(() => {})
        }
      }
    }
    const newBytes = job.plan.totalFileBytes ?? 0
    const backupBytes =
      job.plan.shouldBackup && job.plan.entries.some((entry) => entry.action === 'replace-file')
        ? (job.plan.backupFileBytes ?? 0) + 8192 + Buffer.byteLength(JSON.stringify(job.plan))
        : 0
    const backupDevice = (await inspectLocalPath(this.backups.path)).dev
    const targetDevice = (await inspectLocalPath(root.path)).dev
    const targetRequired = newBytes + (backupDevice === targetDevice ? backupBytes : 0)
    const available = await this.io.availableBytes(root.path)
    if (available !== null && available < BigInt(targetRequired)) {
      throw new ArchiveError('insufficient-space', '目标卷无法同时保存新内容和完整备份。')
    }
    if (backupBytes) {
      await this.backups.capacity(backupBytes + (backupDevice === targetDevice ? newBytes : 0))
    }
    await this.check(job)
  }
  private parent(job: WriteJob, operation: SyncPlanEntry): NativeDirectoryLocation {
    return required(job.locations.get(syncPathKey(operation.path.slice(0, -1))))
  }
  private async directory(job: WriteJob, operation: SyncPlanEntry): Promise<SyncWriteOutcome> {
    const parent = this.parent(job, operation),
      name = required(operation.path.at(-1)),
      path = join(parent.path, name)
    await this.check(job)
    await checkTargetName(parent, name, false)
    checkArchiveAbort(job.signal)
    let hasCreated = false
    try {
      await this.io.mkdir(path)
      hasCreated = true
      const identity = getFileIdentity(await inspectLocalPath(path))
      await parent.verify()
      const listing = await this.source.listDirectory(job.plan.target.rootId, parent.parentId)
      if (listing.status === 'error') {
        throw new ArchiveError(
          listing.error.code === 'result-unknown' ? 'io-failure' : listing.error.code,
          listing.error.message,
        )
      }
      const entry = required(
        listing.value.entries.find((entry) => entry.name === name && entry.kind === 'directory'),
      )
      const location = await this.source.locateNativeDirectory(
        job.plan.target.rootId,
        entry.entryId,
      )
      if (location.identity.dev !== identity.dev || location.identity.ino !== identity.ino) {
        throw new ArchiveError('source-changed', '新目录身份已变化。')
      }
      job.locations.set(syncPathKey(operation.path), location)
      return outcome(operation, 'succeeded')
    } catch (error) {
      if (!hasCreated) {
        hasCreated = await lstat(path).then(
          () => true,
          () => false,
        )
      }
      if (hasCreated) {
        return outcome(operation, 'unknown', {
          code: 'result-unknown',
          message: '目录已创建，但结果未能完整核实，请重读目标。',
          canRetry: false,
        })
      }
      throw error
    }
  }
  private async file(
    job: WriteJob,
    operation: SyncPlanEntry,
    material: WindowsSyncMaterial,
  ): Promise<SyncWriteOutcome> {
    const parent = this.parent(job, operation),
      name = required(operation.path.at(-1)),
      path = join(parent.path, name)
    const source = fileEntry(job.plan, operation, 'source'),
      shouldReplace = operation.action === 'replace-file'
    await this.check(job)
    await checkTargetName(parent, name, shouldReplace)
    const old = shouldReplace
      ? await verifyTargetFile(path, fileEntry(job.plan, operation, 'target'), job.signal)
      : null
    const candidate = await createCandidate(parent)
    job.candidates.add(candidate)
    let hasPublished = false,
      hasAttempted = false
    try {
      const input = await material.openFile(source.entryId)
      try {
        await stageCandidate(
          candidate,
          source,
          input.stream,
          input.verifyUnchanged,
          this.io,
          job.signal,
        )
      } finally {
        input.stream.destroy()
        await finished(input.stream).catch(() => {})
      }
      await this.check(job)
      await checkTargetName(parent, name, shouldReplace)
      await verifyTargetFile(
        candidate.path,
        source,
        job.signal,
        required(candidate.identity),
        false,
      )
      if (old) {
        await verifyTargetFile(
          path,
          fileEntry(job.plan, operation, 'target'),
          job.signal,
          getFileIdentity(old),
        )
      }
      checkArchiveAbort(job.signal)
      hasAttempted = true
      if (shouldReplace) {
        await this.io.rename(candidate.path, path)
        candidate.hasCandidate = false
      } else {
        candidate.linkedPath = path
        await this.io.link(candidate.path, path)
      }
      hasPublished = true
      // 已到提交点的取消不把修改记成未执行；使用独立有界回读确认实际结果。
      await verifyTargetFile(
        path,
        source,
        undefined,
        required(candidate.identity),
        false,
        shouldReplace ? 1n : 2n,
      )
      await parent.verify()
      return outcome(operation, 'succeeded', null, source)
    } catch (error) {
      let isUncertain = hasPublished
      if (hasAttempted && !hasPublished) {
        const current = await lstat(path, { bigint: true }).catch(() => null)
        isUncertain = shouldReplace
          ? !current || !old || !hasSameIdentity(current, getFileIdentity(old))
          : current !== null &&
            candidate.identity !== null &&
            hasSameIdentity(current, candidate.identity)
      }
      if (isUncertain) {
        return outcome(operation, 'unknown', {
          code: 'result-unknown',
          message: '文件发布已开始但结果未能完整核实，请重读目标。',
          canRetry: false,
        })
      }
      throw error
    }
  }
  private async run(
    job: WriteJob,
    material: WindowsSyncMaterial | null,
    options: WindowsSyncWriteOptions,
  ): Promise<SyncApplyResult> {
    const operations = job.plan.entries.filter((entry) =>
      ['create-directory', 'create-file', 'replace-file'].includes(entry.action),
    )
    const outcomes = operations.map((entry) => outcome(entry, 'not-attempted'))
    let error: OperationError | null = null,
      cleanup: OperationError | null = null,
      backupId: string | null = null,
      index = 0
    try {
      this.emit(options, 'checking')
      await this.preflight(job, material)
      this.emit(options, 'backing-up')
      const backup = await this.backups.create(job.plan, { signal: job.signal })
      backupId = backup.manifest?.backupId ?? null
      cleanup = backup.cleanupError
      if (
        job.plan.shouldBackup &&
        operations.some((entry) => entry.action === 'replace-file') &&
        !backup.manifest
      ) {
        throw new ArchiveError('io-failure', '完整保护备份尚未提交。')
      }
      for (const [position, operation] of operations.entries()) {
        index = position
        this.emit(options, 'writing', operation.path)
        await this.check(job)
        const result =
          operation.action === 'create-directory'
            ? await this.directory(job, operation)
            : await this.file(job, operation, required(material))
        outcomes[position] = result
        if (result.status !== 'succeeded') {
          error = result.error
          break
        }
        try {
          await this.clean(job)
        } catch {
          cleanup = cleanupError()
          error = position + 1 < operations.length ? cleanup : null
          break
        }
        index = position + 1
      }
    } catch (cause) {
      const stopped = failure(cause, job.signal)
      error = stopped instanceof ArchiveCancelledError ? null : stopped.operationError
      if (operations[index] && outcomes[index]?.status === 'not-attempted') {
        outcomes[index] = outcome(
          required(operations[index]),
          stopped instanceof ArchiveCancelledError ? 'cancelled' : 'failed',
          error,
        )
      }
      if ('cleanupError' in stopped && stopped.cleanupError) {
        cleanup = stopped.cleanupError
      }
    } finally {
      try {
        await this.clean(job)
      } catch {
        cleanup = cleanupError()
      }
      await job.scanner.stop()
      job.isRunning = false
      if (!job.candidates.size) {
        this.release(job)
      }
    }
    return {
      schemaVersion: 1,
      planId: job.plan.planId,
      backupId,
      outcomes,
      error,
      cleanupError: cleanup,
    }
  }
  private async clean(job: WriteJob): Promise<void> {
    for (const candidate of job.candidates) {
      await cleanupCandidate(candidate, this.io)
      job.candidates.delete(candidate)
    }
  }
  private release(job: WriteJob): void {
    if (this.job === job) {
      this.job = null
    }
    releaseTargetOperation(job.token)
  }
  /** 只重试本进程仍持有的候选，不重放写入，不猜测崩溃前归属。 */
  async retryCleanup(): Promise<void> {
    const job = this.job
    if (!job) {
      return
    }
    if (job.isRunning) {
      throw new ArchiveError('busy', '写入尚未结束。')
    }
    await this.clean(job)
    this.release(job)
  }
  /** 取得已验证且保持引用的本机材料，预览不修改同步目录。 */
  async prepareRestore(
    projectId: string,
    rootId: string,
    backupId: string,
    target: SyncSnapshot,
  ): Promise<WindowsRestorePreparation> {
    if (this.isStopped || target.rootId !== rootId || target.deviceId !== this.source.deviceId) {
      throw new ArchiveError('invalid-request', '恢复目标无效。')
    }
    const handle = await this.backups.acquire(projectId, rootId, backupId)
    let plan: SyncPlan
    try {
      plan = createSyncPlan({
        planId: randomUUID(),
        projectId,
        operation: 'restore',
        direction: 'local-restore',
        shouldBackup: true,
        source: handle.snapshot(),
        target,
      })
      await this.options.authorize(plan)
      if (this.isStopped) {
        throw new ArchiveError('busy', '写入器已停止。')
      }
    } catch (error) {
      await handle.close()
      throw error
    }
    this.preparations.add(handle)
    let hasConsumed = false,
      isRunning = false
    const close = async (): Promise<void> => {
      if (isRunning) {
        throw new ArchiveError('busy', '恢复尚未结束。')
      }
      hasConsumed = true
      const error = await handle.release()
      this.preparations.delete(handle)
      if (error) {
        throw new ArchiveError('cleanup-failed', error.message)
      }
    }
    return {
      get plan() {
        return structuredClone(plan)
      },
      close,
      apply: async (options) => {
        if (hasConsumed) {
          throw new ArchiveError('task-conflict', '本次恢复预览已释放或使用。')
        }
        hasConsumed = true
        isRunning = true
        try {
          const result = await this.apply(
            plan,
            { snapshot: plan.source, openFile: (entryId) => handle.openFile(entryId) },
            options,
          )
          try {
            const error = await handle.release()
            this.preparations.delete(handle)
            return { ...result, cleanupError: result.cleanupError ?? error }
          } catch {
            return { ...result, cleanupError: result.cleanupError ?? cleanupError() }
          }
        } finally {
          isRunning = false
          // 未接纳的确认也释放输入；已有实际结果时，释放错误由 cleanupError 报告。
          if (this.preparations.has(handle)) {
            try {
              await close()
            } catch {
              /* 保留引用供 stop 再次清理。 */
            }
          }
        }
      },
    }
  }
  /** 停止新任务并显式取消当前操作，等待结果和候选/恢复材料释放；失败可再次 stop。 */
  async stop(): Promise<void> {
    this.isStopped = true
    this.job?.controller.abort()
    await this.job?.worker
    await this.retryCleanup()
    for (const handle of this.preparations) {
      await handle.close()
      this.preparations.delete(handle)
    }
  }
}
