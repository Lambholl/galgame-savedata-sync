import { createHash, randomUUID } from 'node:crypto'
import { access, link, lstat, open, readdir, statfs, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  BATCH_LIMITS,
  BATCH_RESOURCES,
  isBatchFileId,
  isOpaqueId,
  isPortableFileName,
  isSha256,
  writeCandidateName,
} from '@savedata-sync/shared'
import type { BatchCleanup, EntryReference, FileOutcome } from '@savedata-sync/shared'
import type { NativeDirectoryLocation, WindowsDirectoryAdapter } from './directory-adapter.ts'
import { getFileIdentity, hasSameIdentity, inspectLocalPath } from './directory-paths.ts'
import type { FileIdentity } from './directory-paths.ts'
import {
  PublicationCancelledError,
  PublicationError,
  toPublicationError,
} from './publication-errors.ts'

/** 发布一个已校验原文的请求，目标用本机 ID 和单文件名表示。 */
export interface NewFilePublicationRequest {
  readonly fileId: string
  readonly rootId: string
  readonly parentId: string | null
  readonly name: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** 发布结果：文件结果与候选文件的清理结果分开报告。 */
export type NewFilePublicationResult = { readonly outcome: FileOutcome } & BatchCleanup

/** 发布器的依赖。 */
export interface NewFilePublisherOptions {
  readonly maxFileBytes?: number
  readonly io?: {
    readonly link?: typeof link
    readonly unlink?: typeof unlink
    readonly availableBytes?: (directory: string) => Promise<bigint>
    readonly sync?: (handle: FileHandle) => Promise<void>
  }
}

/** 发布进度的快照；回读成功前 publishedBytes 为 0。 */
export interface PublicationProgress {
  readonly stage: 'staging' | 'publishing' | 'verifying'
  readonly stagedBytes: number
  readonly readBackBytes: number
  readonly publishedBytes: number
}

/** 发布选项。signal 取消时，已到发布点的文件保留。 */
export interface PublicationOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (value: PublicationProgress) => void
}

interface PublicationJob {
  readonly token: symbol
  readonly request: NewFilePublicationRequest
  readonly grant: NativeDirectoryLocation
  readonly input: Readable
  readonly controller: AbortController
  readonly options: PublicationOptions
  readonly candidateName: string
  readonly handles: Set<FileHandle>
  location: NativeDirectoryLocation | null
  identity: FileIdentity | null
  hasCandidate: boolean
  hasLinked: boolean
  isUncertain: boolean
  isRunning: boolean
  stagedBytes: number
  readBackBytes: number
  cleanupFailure: unknown
  cleaning: Promise<BatchCleanup> | null
  worker: Promise<NewFilePublicationResult> | null
}

// 清理失败时仍占名额，避免不同实例堆积候选文件；这个名额与归档缓存的名额独立，接收完归档后才能发布。
let activePublication: symbol | null = null

function validateRequest(value: unknown): asserts value is NewFilePublicationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicationError('invalid-request', 'The new file request is invalid.')
  }
  const record = value as Record<string, unknown>
  const keys = ['fileId', 'rootId', 'parentId', 'name', 'sizeBytes', 'sha256']
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    !isBatchFileId(record.fileId) ||
    !isOpaqueId(record.rootId) ||
    !(record.parentId === null || isOpaqueId(record.parentId)) ||
    !isPortableFileName(record.name) ||
    !Number.isSafeInteger(record.sizeBytes) ||
    typeof record.sizeBytes !== 'number' ||
    record.sizeBytes < 0 ||
    record.sizeBytes > BATCH_LIMITS.maxFileBytes ||
    !isSha256(record.sha256)
  ) {
    throw new PublicationError(
      'invalid-request',
      'New file request fields are invalid or exceed protocol limits.',
    )
  }
}

function checkAbort(job: PublicationJob): void {
  if (!job.controller.signal.aborted) {
    return
  }
  const reason: unknown = job.controller.signal.reason
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    throw new PublicationError('timeout', 'New file publication timed out.', reason)
  }
  throw new PublicationCancelledError()
}

/**
 * 在已授权的根目录里发布新文件：候选文件独占创建在目标父目录，校验原文并落盘后用硬链接发布，
 * 已有的同名文件保留，文件系统不支持硬链接时发布失败。最终回读成功才报告 succeeded。
 * 写授权由 grant 给出，只在当前进程内有效。
 */
export class WindowsNewFilePublisher {
  private readonly source: Pick<WindowsDirectoryAdapter, 'locateNativeDirectory'>
  private readonly grants = new Map<string, NativeDirectoryLocation>()
  private readonly maxFileBytes: number
  private readonly io: NonNullable<NewFilePublisherOptions['io']>
  private job: PublicationJob | null = null
  private isStopped = false
  private stopping: Promise<void> | null = null

  constructor(
    source: Pick<WindowsDirectoryAdapter, 'locateNativeDirectory'>,
    options: NewFilePublisherOptions = {},
  ) {
    this.source = source
    this.maxFileBytes = options.maxFileBytes ?? BATCH_LIMITS.maxFileBytes
    this.io = options.io ?? {}
    if (
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes < 0 ||
      this.maxFileBytes > BATCH_LIMITS.maxFileBytes
    ) {
      throw new PublicationError('invalid-request', 'The native file budget is invalid.')
    }
  }

  /** 核实已登记目录的身份和写权限，并授予写授权。 */
  async grant(rootId: string): Promise<void> {
    if (this.isStopped) {
      throw new PublicationError('busy', 'The publication adapter has stopped.')
    }
    const location = await this.source.locateNativeDirectory(rootId).catch((error: unknown) => {
      throw toPublicationError(error)
    })
    await access(location.path, constants.W_OK).catch((error: unknown) => {
      throw toPublicationError(error)
    })
    if (this.isStopped) {
      throw new PublicationError('busy', 'The publication adapter has stopped.')
    }
    const existing = this.grants.get(rootId)
    if (
      existing &&
      existing.path === location.path &&
      existing.identity.dev === location.identity.dev &&
      existing.identity.ino === location.identity.ino
    ) {
      return
    }
    this.grants.set(rootId, location)
  }

  /** 撤销根目录的写授权；进行中的操作在发布点前取消，过了发布点的返回实际结果。 */
  async revoke(rootId: string): Promise<void> {
    this.grants.delete(rootId)
    if (this.job?.request.rootId === rootId) {
      this.job.controller.abort()
      await this.job.worker
      await this.retryCleanup()
    }
  }

  /**
   * 预检一个发布目标：授权、父目录、容量和当前的同名冲突。结果只反映检查那一刻的状态，名称和容量都不预留。
   *
   * @param requiredBytes 需要的字节数，缺省时取单个文件大小。
   * @param privateSpace 私有缓存所在卷；与目标同卷时合计所需空间。
   * @returns 物理父目录和不区分大小写的名称键，可用来给一批目标去重。
   */
  async checkTarget(
    value: unknown,
    requiredBytes?: number,
    privateSpace?: { readonly device: string; readonly requiredBytes: number },
  ): Promise<string> {
    try {
      validateRequest(value)
      const request = Object.freeze({ ...value })
      const bytes = requiredBytes ?? request.sizeBytes
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < request.sizeBytes ||
        bytes > BATCH_LIMITS.maxTotalFileBytes
      ) {
        throw new PublicationError(
          'invalid-request',
          'The target space preflight byte count is invalid.',
        )
      }
      if (this.isStopped) {
        throw new PublicationError('busy', 'The publication adapter has stopped.')
      }
      const grant = this.grants.get(request.rootId)
      if (!grant) {
        throw new PublicationError(
          'permission-denied',
          'The target root has no write authorization in this process.',
        )
      }
      if (request.sizeBytes > this.maxFileBytes) {
        throw new PublicationError('resource-limit', 'The file exceeds the local budget.')
      }
      await grant.verify()
      const location = await this.source.locateNativeDirectory(request.rootId, request.parentId)
      const peakBytes =
        bytes + (privateSpace?.device === location.identity.dev ? privateSpace.requiredBytes : 0)
      if ((await (this.io.availableBytes ?? availableBytes)(location.path)) < BigInt(peakBytes)) {
        throw new PublicationError(
          'insufficient-space',
          'The target volume has insufficient space to receive this file batch.',
        )
      }
      const names = await readdir(location.path)
      if (names.some((name) => name.toLowerCase() === request.name.toLowerCase())) {
        throw new PublicationError('name-conflict', 'The target name already exists.')
      }
      await location.verify()
      await grant.verify()
      if (this.grants.get(request.rootId) !== grant || this.isStopped) {
        throw new PublicationError('permission-denied', 'This write authorization expired.')
      }
      return `${location.identity.dev}:${location.identity.ino}\0${request.name.toLowerCase()}`
    } catch (error) {
      throw toPublicationError(error)
    }
  }

  /**
   * 发布一个文件，接管并最终关闭输入流。
   *
   * @returns 文件结果。
   * @throws PublicationError 请求字段非法时抛出。
   */
  async publish(
    value: unknown,
    input: Readable,
    options: PublicationOptions = {},
  ): Promise<NewFilePublicationResult> {
    const rememberError = (): void => undefined
    input.on('error', rememberError)
    let signal: AbortSignal | undefined
    let abort: (() => void) | undefined
    try {
      validateRequest(value)
      const request = Object.freeze({ ...value })
      const grant = this.grants.get(request.rootId)
      const unavailable = this.isStopped
        ? 'busy'
        : !grant
          ? 'permission-denied'
          : activePublication !== null
            ? 'busy'
            : request.sizeBytes > this.maxFileBytes
              ? 'resource-limit'
              : null
      if (unavailable || !grant) {
        return {
          outcome: {
            fileId: request.fileId,
            status: 'failed',
            error: new PublicationError(
              unavailable ?? 'permission-denied',
              'Write authorization is missing, the budget is insufficient, or a candidate is awaiting cleanup.',
            ).operationError,
            residualEntries: [],
          },
          cleanupStatus: 'not-needed',
          cleanupError: null,
        }
      }
      const controller = new AbortController()
      signal = options.signal
      abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) {
        abort()
      } else {
        signal?.addEventListener('abort', abort, { once: true })
      }
      controller.signal.addEventListener('abort', () => input.destroy(), { once: true })
      const job: PublicationJob = {
        token: Symbol('new-file'),
        request,
        grant,
        input,
        controller,
        options,
        candidateName: writeCandidateName('new', randomUUID()),
        handles: new Set(),
        location: null,
        identity: null,
        hasCandidate: false,
        hasLinked: false,
        isUncertain: false,
        isRunning: true,
        stagedBytes: 0,
        readBackBytes: 0,
        cleanupFailure: null,
        cleaning: null,
        worker: null,
      }
      this.job = job
      activePublication = job.token
      job.worker = this.execute(job)
      return await job.worker
    } finally {
      if (signal && abort) {
        signal.removeEventListener('abort', abort)
      }
      input.destroy()
      await finished(input, { cleanup: true }).catch(() => undefined)
      input.off('error', rememberError)
    }
  }

  /** 清理本实例持有且身份仍匹配的候选文件；已发布的最终文件和来历不明的替换物保留。 */
  async retryCleanup(): Promise<void> {
    const job = this.job
    if (!job) {
      return
    }
    if (job.isRunning) {
      throw new PublicationError('busy', 'The new file operation has not finished.')
    }
    const cleanup = await this.clean(job)
    if (cleanup.cleanupStatus === 'incomplete') {
      throw new PublicationError(
        'cleanup-failed',
        'Candidate cleanup failed. Check permissions and directory identity.',
        job.cleanupFailure,
      )
    }
    this.release(job)
  }

  /** 停止发布器：撤销全部授权，等待进行中的操作并清理候选文件；清理失败时可以再次 stop。 */
  stop(): Promise<void> {
    this.isStopped = true
    this.grants.clear()
    this.job?.controller.abort()
    if (!this.stopping) {
      this.stopping = this.close().finally(() => {
        this.stopping = null
      })
    }
    return this.stopping
  }

  private async close(): Promise<void> {
    await this.job?.worker
    await this.retryCleanup()
  }

  private async verifyGrant(job: PublicationJob): Promise<void> {
    checkAbort(job)
    if (this.grants.get(job.request.rootId) !== job.grant) {
      throw new PublicationError('permission-denied', 'This write authorization expired.')
    }
    await job.grant.verify()
    await job.location?.verify()
    checkAbort(job)
  }

  private emit(job: PublicationJob, stage: PublicationProgress['stage'], publishedBytes = 0): void {
    job.options.onProgress?.(
      Object.freeze({
        stage,
        stagedBytes: job.stagedBytes,
        readBackBytes: job.readBackBytes,
        publishedBytes,
      }),
    )
  }

  private async execute(job: PublicationJob): Promise<NewFilePublicationResult> {
    let outcome: FileOutcome
    try {
      await this.verifyGrant(job)
      job.location = await this.source.locateNativeDirectory(
        job.request.rootId,
        job.request.parentId,
      )
      await this.verifyGrant(job)
      await this.assertNameFree(job)
      await this.stage(job)
      this.emit(job, 'publishing')
      await this.verifyGrant(job)
      await this.assertCandidate(job)
      await this.assertNameFree(job)
      checkAbort(job)
      const candidate = join(job.location.path, job.candidateName)
      const target = join(job.location.path, job.request.name)
      try {
        await (this.io.link ?? link)(candidate, target)
        job.hasLinked = true
      } catch (error) {
        const targetStats = await lstat(target, { bigint: true }).catch(() => null)
        if (targetStats && job.identity && hasSameIdentity(targetStats, job.identity)) {
          job.isUncertain = true
        }
        throw error
      }
      // link 成功后不因取消回滚新文件，完成有界回读以报告实际结果。
      await this.readBack(job, target)
      if (!job.identity) {
        throw new PublicationError('source-changed', 'The candidate identity is unavailable.')
      }
      const entry = await job.location.describeFile(job.request.name, job.identity)
      this.emit(job, 'verifying', job.request.sizeBytes)
      outcome = {
        fileId: job.request.fileId,
        status: 'succeeded',
        bytesWritten: job.request.sizeBytes,
        sha256: job.request.sha256,
        entry,
      }
    } catch (error) {
      let failure = error
      if (!(error instanceof PublicationError) && job.controller.signal.aborted) {
        try {
          checkAbort(job)
        } catch (cancelled) {
          failure = cancelled
        }
      }
      const residualEntries = await this.residuals(job, job.hasLinked ? job.request.name : null)
      if (job.hasLinked || job.isUncertain) {
        outcome = {
          fileId: job.request.fileId,
          status: 'unknown',
          error: {
            code: 'result-unknown',
            message:
              'Publication started but the result could not be fully verified. Read the target again.',
            canRetry: false,
          },
          residualEntries,
        }
      } else if (failure instanceof PublicationCancelledError) {
        outcome = { fileId: job.request.fileId, status: 'cancelled', residualEntries: [] }
      } else {
        outcome = {
          fileId: job.request.fileId,
          status: 'failed',
          error: toPublicationError(failure).operationError,
          residualEntries: [],
        }
      }
    }
    const cleanup = await this.clean(job)
    if (
      cleanup.cleanupStatus === 'incomplete' &&
      (outcome.status === 'failed' ||
        outcome.status === 'cancelled' ||
        outcome.status === 'unknown')
    ) {
      outcome = {
        ...outcome,
        residualEntries: [
          ...outcome.residualEntries,
          ...(await this.residuals(job, job.candidateName)),
        ],
      }
    }
    job.isRunning = false
    if (cleanup.cleanupStatus !== 'incomplete') {
      this.release(job)
    }
    return { outcome, ...cleanup }
  }

  private async assertNameFree(job: PublicationJob): Promise<void> {
    if (!job.location) {
      throw new PublicationError('invalid-request', 'The target parent directory is unavailable.')
    }
    const names = await readdir(job.location.path)
    if (names.some((name) => name.toLowerCase() === job.request.name.toLowerCase())) {
      throw new PublicationError(
        'name-conflict',
        'The target name already exists. The existing entry was not overwritten.',
      )
    }
  }

  private async assertCandidate(job: PublicationJob): Promise<void> {
    if (!job.location || !job.identity) {
      throw new PublicationError('source-changed', 'The candidate identity is unavailable.')
    }
    await job.location.verify()
    const stats = await inspectLocalPath(join(job.location.path, job.candidateName))
    if (
      !stats.isFile() ||
      !hasSameIdentity(stats, job.identity) ||
      stats.nlink !== 1n ||
      stats.size !== BigInt(job.request.sizeBytes)
    ) {
      throw new PublicationError('source-changed', 'The candidate file changed.')
    }
  }

  private async stage(job: PublicationJob): Promise<void> {
    if (!job.location) {
      throw new PublicationError('invalid-request', 'The target parent directory is unavailable.')
    }
    const handle = await open(join(job.location.path, job.candidateName), 'wx', 0o600)
    job.handles.add(handle)
    job.hasCandidate = true
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.nlink !== 1n) {
      throw new PublicationError('source-changed', 'The candidate creation identity is invalid.')
    }
    job.identity = getFileIdentity(stats)
    const hash = createHash('sha256')
    this.emit(job, 'staging')
    for await (const chunk of job.input) {
      if (!Buffer.isBuffer(chunk)) {
        throw new PublicationError(
          'invalid-request',
          'The uncompressed content stream must provide binary data.',
        )
      }
      for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
        const bytes = chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
        await this.verifyGrant(job)
        if (
          job.stagedBytes + bytes.length > job.request.sizeBytes ||
          job.stagedBytes + bytes.length > this.maxFileBytes
        ) {
          throw new PublicationError(
            'checksum-mismatch',
            'Actual uncompressed content exceeds the declared length.',
          )
        }
        const available = await (this.io.availableBytes ?? availableBytes)(job.location.path)
        if (available < BigInt(bytes.length)) {
          throw new PublicationError(
            'insufficient-space',
            'The target volume has insufficient free space.',
          )
        }
        for (let written = 0; written < bytes.length;) {
          checkAbort(job)
          const result = await handle.write(bytes, written, bytes.length - written)
          if (result.bytesWritten <= 0) {
            throw new PublicationError('io-failure', 'The candidate write made no progress.')
          }
          written += result.bytesWritten
        }
        hash.update(bytes)
        job.stagedBytes += bytes.length
        this.emit(job, 'staging')
      }
    }
    checkAbort(job)
    if (job.stagedBytes !== job.request.sizeBytes || hash.digest('hex') !== job.request.sha256) {
      throw new PublicationError(
        'checksum-mismatch',
        'The uncompressed content length or SHA-256 does not match.',
      )
    }
    await (this.io.sync ?? ((file) => file.sync()))(handle)
    await handle.close()
    job.handles.delete(handle)
  }

  private async readBack(job: PublicationJob, target: string): Promise<void> {
    const handle = await open(target, 'r')
    job.handles.add(handle)
    try {
      const before = await handle.stat({ bigint: true })
      if (!job.identity || !before.isFile() || !hasSameIdentity(before, job.identity)) {
        throw new PublicationError('source-changed', 'The final file identity does not match.')
      }
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(BATCH_RESOURCES.maxBufferBytes)
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, job.readBackBytes)
        if (bytesRead === 0) {
          break
        }
        job.readBackBytes += bytesRead
        if (job.readBackBytes > job.request.sizeBytes) {
          throw new PublicationError(
            'checksum-mismatch',
            'The final file exceeds the expected length.',
          )
        }
        hash.update(buffer.subarray(0, bytesRead))
        this.emit(job, 'verifying')
      }
      const after = await handle.stat({ bigint: true })
      if (
        !hasSameIdentity(after, job.identity) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        job.readBackBytes !== job.request.sizeBytes ||
        hash.digest('hex') !== job.request.sha256
      ) {
        throw new PublicationError(
          'checksum-mismatch',
          'The final file content or attributes observed while reading do not match.',
        )
      }
    } finally {
      await handle.close()
      job.handles.delete(handle)
    }
  }

  private async residuals(job: PublicationJob, name: string | null): Promise<EntryReference[]> {
    if (!name || !job.location || !job.identity) {
      return []
    }
    try {
      const entry = await job.location.describeFile(name, job.identity)
      return [{ rootId: entry.rootId, entryId: entry.entryId }]
    } catch {
      return []
    }
  }

  private clean(job: PublicationJob): Promise<BatchCleanup> {
    if (!job.cleaning) {
      job.cleaning = this.removeCandidate(job).finally(() => {
        job.cleaning = null
      })
    }
    return job.cleaning
  }

  private async removeCandidate(job: PublicationJob): Promise<BatchCleanup> {
    try {
      for (const handle of job.handles) {
        await handle.close()
        job.handles.delete(handle)
      }
      if (job.hasCandidate) {
        if (!job.location) {
          throw new PublicationError('cleanup-failed', 'Candidate ownership could not be verified.')
        }
        await job.location.verify()
        const path = join(job.location.path, job.candidateName)
        const stats = await lstat(path, { bigint: true }).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return null
          }
          throw error
        })
        if (stats) {
          if (
            !job.identity ||
            !stats.isFile() ||
            stats.isSymbolicLink() ||
            !hasSameIdentity(stats, job.identity)
          ) {
            throw new PublicationError(
              'cleanup-failed',
              'The candidate was replaced. The unknown entry was not deleted.',
            )
          }
          await (this.io.unlink ?? unlink)(path)
        }
        job.hasCandidate = false
      }
      return { cleanupStatus: 'complete', cleanupError: null }
    } catch (error) {
      job.cleanupFailure = error
      return {
        cleanupStatus: 'incomplete',
        cleanupError: {
          code: 'cleanup-failed',
          message:
            'Candidate cleanup is incomplete. Check directory identity and permissions, then retry.',
          canRetry: false,
        },
      }
    }
  }

  private release(job: PublicationJob): void {
    if (this.job === job) {
      this.job = null
    }
    if (activePublication === job.token) {
      activePublication = null
    }
  }
}

async function availableBytes(directory: string): Promise<bigint> {
  const stats = await statfs(directory, { bigint: true })
  return stats.bavail * stats.bsize
}
