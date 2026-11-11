import { randomUUID } from 'node:crypto'
import { access, lstat, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  SYNC_LIMITS,
  BATCH_TIMEOUTS_MS,
  createSyncPlan,
  isSyncFileWrite,
  isSyncPlan,
  isSyncWriteEntry,
  matchesSyncPlan,
  selectSyncBackupFiles,
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
import type { FileIdentity } from './directory-paths.ts'
import type { WindowsBackupHandle, WindowsBackupStore } from './backup-store.ts'
import {
  ArchiveCancelledError,
  ArchiveError,
  checkArchiveAbort,
  toArchiveError,
} from './archive-errors.ts'
import { hashBackupStream } from './backup-files.ts'
import type { InterruptedWriteStore } from './interrupted-writes.ts'
import { toPublicationError } from './publication-errors.ts'
import { WindowsSyncScanner } from './sync-scanner.ts'
import {
  acquireTargetOperation,
  ownsTargetOperation,
  releaseTargetOperation,
} from './target-operation.ts'
import {
  SYNC_TARGET_IO,
  checkTargetName,
  cleanupCandidate,
  createCandidate,
  removeLeftoverCandidates,
  stageCandidate,
  verifyTargetFile,
} from './sync-target-files.ts'
import type { SyncCandidate, SyncTargetIO } from './sync-target-files.ts'

/** 写入用的输入，已完整校验，可以重复读取；快照必须与确认的计划相符，打开的流由写入器关闭。 */
export interface WindowsSyncMaterial {
  readonly snapshot: SyncSnapshot
  readonly openFile: (
    entryId: string,
  ) => Promise<{ stream: Readable; verifyUnchanged: () => Promise<void> }>
}
/** 写入器的依赖：authorize 核对计划的项目和目标根目录仍与本机配置一致。 */
export interface WindowsSyncWriterOptions {
  readonly authorize: (plan: SyncPlan) => void | Promise<void>
  /** 写入标记的存储；不传时不记录写入标记。 */
  readonly interruptedWrites?: Pick<InterruptedWriteStore, 'begin' | 'end'>
  readonly io?: Partial<SyncTargetIO>
  readonly timeoutMs?: number
}
/** apply 的选项。阶段回调抛出的错误被忽略。 */
export interface WindowsSyncWriteOptions {
  readonly signal?: AbortSignal
  /** 调用方已取得的写入名额；给出时写入器借用它，不负责释放。 */
  readonly lease?: { readonly token: symbol; readonly acceptedAt: number }
  /** 每次发布前调用；抛错时中止后续写入。 */
  readonly verifyContext?: () => void | Promise<void>
  readonly onOutcome?: (outcome: SyncWriteOutcome) => void
  readonly onStage?: (
    stage: 'checking' | 'backing-up' | 'writing',
    path: readonly string[] | null,
  ) => void
}
/** 恢复预览：apply 和 close 二选一，调用前一直持有备份的引用。 */
export interface WindowsRestorePreparation {
  readonly plan: SyncPlan
  readonly apply: (options?: WindowsSyncWriteOptions) => Promise<SyncApplyResult>
  readonly close: () => Promise<void>
}
interface WriteJob {
  readonly token: symbol
  readonly hasOwnToken: boolean
  readonly verifyContext: () => void | Promise<void>
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
    throw new ArchiveError(
      'invalid-request',
      'The confirmed plan is missing the reference for this operation.',
    )
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
    throw new ArchiveError('invalid-request', 'The file lacks a complete content fingerprint.')
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
    message:
      'File candidates or restore material were not fully released. Verify them and retry cleanup.',
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
    operation.action !== 'replace-file' &&
    operation.action !== 'delete-file' &&
    operation.action !== 'delete-directory'
  ) {
    throw new ArchiveError('invalid-request', 'The current plan item has no write action.')
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
 * 执行已确认的计划：整批复核和备份后逐个文件发布，结果只记录实际观察到的情况。
 * 执行期间占用写入名额；清理失败时保留名额，由 retryCleanup 释放。
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
      throw new ArchiveError('invalid-request', 'The target write deadline is invalid.')
    }
  }
  /** 执行计划：非法、过期、重复确认或 busy 时拒绝；任务接受后的失败和取消都返回完整的逐项结果。 */
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
          shouldDeleteExtras: value.shouldDeleteExtras,
          source: material.snapshot,
          target: value.target,
        })) ||
      (value.transferFileCount > 0 && !material)
    ) {
      throw new ArchiveError(
        'invalid-request',
        'The target or native material does not match the complete confirmed plan.',
      )
    }
    if (this.isStopped || this.job) {
      throw new ArchiveError('busy', 'The writer stopped or resources are still awaiting cleanup.')
    }
    if (this.usedIds.has(value.planId)) {
      throw new ArchiveError('task-conflict', 'This confirmation was already used. Scan again.')
    }
    if (this.usedIds.size >= 4096) {
      throw new ArchiveError(
        'resource-limit',
        'The confirmation ID capacity for this process is full.',
      )
    }
    const now = Date.now(),
      acceptedAt = options.lease?.acceptedAt ?? now
    if (
      !Number.isSafeInteger(acceptedAt) ||
      acceptedAt > now ||
      now - acceptedAt > BATCH_TIMEOUTS_MS.total ||
      (options.lease && !ownsTargetOperation(options.lease.token))
    ) {
      throw new ArchiveError(
        'task-conflict',
        "The accepted task's operation slot or deadline expired.",
      )
    }
    if (
      (value.operation === 'restore' ? [value.source, value.target] : [value.target]).some(
        (snapshot) =>
          snapshot.observedAt > acceptedAt ||
          acceptedAt - snapshot.observedAt > SYNC_LIMITS.snapshotLifetimeMs,
      )
    ) {
      throw new ArchiveError('not-found', 'The local scan or restore preview expired. Scan again.')
    }
    const token = options.lease?.token ?? Symbol('sync-write')
    if (!options.lease) {
      acquireTargetOperation(token)
    }
    const controller = new AbortController()
    const job: WriteJob = {
      token,
      hasOwnToken: !options.lease,
      verifyContext: options.verifyContext ?? (() => undefined),
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
    await job.verifyContext()
    await this.options.authorize(structuredClone(job.plan))
    checkArchiveAbort(job.signal)
    await required(job.locations.get(syncPathKey([]))).verify()
  }
  private async preflight(job: WriteJob, material: WindowsSyncMaterial | null): Promise<void> {
    await job.verifyContext()
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
          state.error?.message ?? 'The target verification scan is incomplete.',
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
        throw new ArchiveError(
          'source-changed',
          'The target content differs from confirmation. Scan again.',
        )
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
      if (isSyncFileWrite(operation.action)) {
        checkArchiveAbort(job.signal)
        const entry = fileEntry(job.plan, operation, 'source')
        const input = await required(material).openFile(entry.entryId)
        try {
          const actual = await hashBackupStream(input.stream, entry.sizeBytes ?? -1, job.signal)
          await input.verifyUnchanged()
          if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
            throw new ArchiveError(
              'checksum-mismatch',
              'The complete input differs from the confirmed plan.',
            )
          }
        } finally {
          input.stream.destroy()
          await finished(input.stream).catch(() => {})
        }
      }
    }
    await this.checkSpace(job.plan)
    await this.check(job)
  }
  /** 检查目标卷和备份卷能否放下新文件、完整备份和传入的私有缓存，同卷的空间相加；不够时抛错。 */
  async checkSpace(
    plan: SyncPlan,
    privateSpace?: { readonly device: string; readonly requiredBytes: number },
  ): Promise<void> {
    if (
      !isSyncPlan(plan) ||
      !plan.canExecute ||
      plan.target.deviceId !== this.source.deviceId ||
      (privateSpace &&
        (!Number.isSafeInteger(privateSpace.requiredBytes) || privateSpace.requiredBytes < 0))
    ) {
      throw new ArchiveError('invalid-request', 'The target capacity plan is invalid.')
    }
    await this.options.authorize(structuredClone(plan))
    const root = await this.source.locateNativeDirectory(plan.target.rootId)
    const newBytes = plan.totalFileBytes ?? 0
    const backupBytes =
      selectSyncBackupFiles(plan).length > 0
        ? (plan.backupFileBytes ?? 0) + 8192 + Buffer.byteLength(JSON.stringify(plan))
        : 0
    const backupDevice = (await inspectLocalPath(await this.backups.root())).dev
    const targetDevice = (await inspectLocalPath(root.path)).dev
    const targetRequired =
      newBytes +
      (backupDevice === targetDevice ? backupBytes : 0) +
      (privateSpace?.device === targetDevice.toString() ? privateSpace.requiredBytes : 0)
    const available = await this.io.availableBytes(root.path)
    if (available !== null && available < BigInt(targetRequired)) {
      throw new ArchiveError(
        'insufficient-space',
        'The target volume cannot hold both the new content and a complete backup.',
      )
    }
    if (backupBytes) {
      await this.backups.capacity(
        backupBytes +
          (backupDevice === targetDevice ? newBytes : 0) +
          (privateSpace?.device === backupDevice.toString() ? privateSpace.requiredBytes : 0),
      )
    }
    await root.verify()
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
        throw new ArchiveError('source-changed', 'The new directory identity changed.')
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
          message:
            'The directory was created but the result could not be fully verified. Read the target again.',
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
      // 已到提交点的取消不把修改记成未执行；用独立的有界回读确认实际结果。
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
          message:
            'File publication started but the result could not be fully verified. Read the target again.',
          canRetry: false,
        })
      }
      throw error
    }
  }
  /**
   * 删除一项目标多出的条目：文件先核对身份和完整内容，目录只删空目录。
   * 系统已开始删除但结果没能确认时报 unknown；条目还在且身份未变时按失败抛出。
   */
  private async remove(job: WriteJob, operation: SyncPlanEntry): Promise<SyncWriteOutcome> {
    const parent = this.parent(job, operation),
      name = required(operation.path.at(-1)),
      path = join(parent.path, name),
      isDirectory = operation.action === 'delete-directory'
    await this.check(job)
    await checkTargetName(parent, name, true)
    let identity: FileIdentity
    if (isDirectory) {
      const location = required(job.locations.get(syncPathKey(operation.path)))
      await location.verify()
      if ((await readdir(location.path)).length > 0) {
        throw new ArchiveError('source-changed', 'The directory to delete is no longer empty.')
      }
      identity = location.identity
    } else {
      identity = getFileIdentity(
        await verifyTargetFile(path, fileEntry(job.plan, operation, 'target'), job.signal),
      )
    }
    await this.check(job)
    checkArchiveAbort(job.signal)
    try {
      await (isDirectory ? this.io.rmdir(path) : this.io.unlink(path))
    } catch (error) {
      const current = await lstat(path, { bigint: true }).catch(() => null)
      if (current && hasSameIdentity(current, identity)) {
        throw error
      }
      return outcome(operation, 'unknown', {
        code: 'result-unknown',
        message:
          'Deletion started but the result could not be fully verified. Read the target again.',
        canRetry: false,
      })
    }
    // 已到提交点的取消不把修改记成未执行；用独立回读确认条目确实不在了。
    const isGone = await lstat(path, { bigint: true }).then(
      () => false,
      (error: unknown) =>
        Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'),
    )
    if (!isGone) {
      return outcome(operation, 'unknown', {
        code: 'result-unknown',
        message:
          'Deletion finished but the entry could not be confirmed gone. Read the target again.',
        canRetry: false,
      })
    }
    job.locations.delete(syncPathKey(operation.path))
    return outcome(operation, 'succeeded')
  }
  private async run(
    job: WriteJob,
    material: WindowsSyncMaterial | null,
    options: WindowsSyncWriteOptions,
  ): Promise<SyncApplyResult> {
    const operations = job.plan.entries.filter(isSyncWriteEntry)
    const outcomes = operations.map((entry) => outcome(entry, 'not-attempted'))
    let error: OperationError | null = null,
      cleanup: OperationError | null = null,
      backupId: string | null = null,
      backupFileCount: number | null = null,
      index = 0
    try {
      this.emit(options, 'checking')
      await this.preflight(job, material)
      this.emit(options, 'backing-up')
      const backup = await this.backups.create(job.plan, { signal: job.signal })
      backupId = backup.manifest?.backupId ?? null
      backupFileCount = backup.manifest?.files.length ?? null
      cleanup = backup.cleanupError
      if (selectSyncBackupFiles(job.plan).length > 0 && !backup.manifest) {
        throw new ArchiveError('io-failure', 'A complete protective backup has not been committed.')
      }
      if (operations.length > 0) {
        await this.options.interruptedWrites?.begin(job.plan, backupId)
        // 写入名额和单实例锁保证此刻没有其他写入，目标里的候选文件都是之前中断写入的残留。
        // 先删掉它们，计划里要删除的目录才是空的。
        await removeLeftoverCandidates(
          required(job.locations.get(syncPathKey([]))),
          this.io,
          job.signal,
        )
      }
      for (const [position, operation] of operations.entries()) {
        index = position
        this.emit(options, 'writing', operation.path)
        await this.check(job)
        const result =
          operation.action === 'create-directory'
            ? await this.directory(job, operation)
            : isSyncFileWrite(operation.action)
              ? await this.file(job, operation, required(material))
              : await this.remove(job, operation)
        outcomes[position] = result
        try {
          options.onOutcome?.(structuredClone(result))
        } catch {
          /* 观察者不改变已核实结果。 */
        }
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
      await this.options.interruptedWrites?.end(job.plan.planId)
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
      backupFileCount,
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
    if (job.hasOwnToken) {
      releaseTargetOperation(job.token)
    }
  }
  /** 重试清理仍持有的候选文件。 */
  async retryCleanup(): Promise<void> {
    const job = this.job
    if (!job) {
      return
    }
    if (job.isRunning) {
      throw new ArchiveError('busy', 'Writing has not finished.')
    }
    await this.clean(job)
    this.release(job)
  }
  /** 用已取得引用的备份生成恢复预览；同步目录不变。 */
  async prepareRestore(
    projectId: string,
    rootId: string,
    backupId: string,
    target: SyncSnapshot,
  ): Promise<WindowsRestorePreparation> {
    if (this.isStopped || target.rootId !== rootId || target.deviceId !== this.source.deviceId) {
      throw new ArchiveError('invalid-request', 'The restore target is invalid.')
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
        shouldDeleteExtras: false,
        source: handle.snapshot(),
        target,
      })
      await this.options.authorize(plan)
      if (this.isStopped) {
        throw new ArchiveError('busy', 'The writer has stopped.')
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
        throw new ArchiveError('busy', 'The restore has not finished.')
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
          throw new ArchiveError('task-conflict', 'This restore preview was released or used.')
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
  /** 停止接受新任务并取消当前操作，等待结果以及候选文件和恢复材料释放；失败后可以再次 stop。 */
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
