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

/** 已验证原文的单文件目标；只接收本机 ID 与单文件名，不接收路径。 */
export interface NewFilePublicationRequest {
  readonly fileId: string
  readonly rootId: string
  readonly parentId: string | null
  readonly name: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** 逐文件实际结果与候选清理分开，清理失败不推翻已回读确认的成功。 */
export type NewFilePublicationResult = { readonly outcome: FileOutcome } & BatchCleanup

/** 原生依赖注入，不经 HTTP/IPC 配置；文件系统不支持 link 时失败关闭。 */
export interface NewFilePublisherOptions {
  readonly maxFileBytes?: number
  readonly io?: {
    readonly link?: typeof link
    readonly unlink?: typeof unlink
    readonly availableBytes?: (directory: string) => Promise<bigint>
    readonly sync?: (handle: FileHandle) => Promise<void>
  }
}

/** 回调为同步快照；回读尚未成功时 publishedBytes 为 0，不能用于计算批次校验计数。 */
export interface PublicationProgress {
  readonly stage: 'staging' | 'publishing' | 'verifying'
  readonly stagedBytes: number
  readonly readBackBytes: number
  readonly publishedBytes: number
}

/** 输入流从调用起由适配器持有并最终关闭；signal 不回滚已进入发布点的最终文件。 */
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

// 清理失败仍占名额，避免不同原生实例堆积候选；与归档缓存名额独立以支持接收后发布。
let activePublication: symbol | null = null

function validateRequest(value: unknown): asserts value is NewFilePublicationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicationError('invalid-request', '新文件请求无效。')
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
    throw new PublicationError('invalid-request', '新文件请求字段无效或超过协议限制。')
  }
}

function checkAbort(job: PublicationJob): void {
  if (!job.controller.signal.aborted) {
    return
  }
  const reason: unknown = job.controller.signal.reason
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    throw new PublicationError('timeout', '新文件发布超时。', reason)
  }
  throw new PublicationCancelledError()
}

/**
 * Windows 新文件原生发布，读取登记不会自动授予写权限，grant 仅在本进程存活。
 * 候选独占创建于目标父目录，校验原文并 sync 后用硬链接发布，绝不覆盖既有名字。
 * 输入/候选/回读均有限缓冲；最终回读成功才报告 succeeded；取消竞争及不确定结果不自动重试。
 * stop 撤销授权并等待资源释放，清理失败可 retryCleanup；句柄/路径不经 Renderer 暴露。
 * 不实现 HTTP、批次发布、恢复旧任务或跨进程孤儿候选删除；用法与边界见桌面 README。
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
      throw new PublicationError('invalid-request', '原生文件预算无效。')
    }
  }

  /** 核实已选择目录的身份与写权限；游戏配置在接收前恢复此进程内授权。 */
  async grant(rootId: string): Promise<void> {
    if (this.isStopped) {
      throw new PublicationError('busy', '发布适配器已停止。')
    }
    const location = await this.source.locateNativeDirectory(rootId).catch((error: unknown) => {
      throw toPublicationError(error)
    })
    await access(location.path, constants.W_OK).catch((error: unknown) => {
      throw toPublicationError(error)
    })
    if (this.isStopped) {
      throw new PublicationError('busy', '发布适配器已停止。')
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

  /** 撤销后不接纳该根的新写入；已有操作在发布点前取消，之后返回可观察实际结果。 */
  async revoke(rootId: string): Promise<void> {
    this.grants.delete(rootId)
    if (this.job?.request.rootId === rootId) {
      this.job.controller.abort()
      await this.job.worker
      await this.retryCleanup()
    }
  }

  /**
   * 只读预检供后续 receiver 在接收归档前核对授权、父目录、预算和当前同名冲突。
   * requiredBytes 默认单文件，可传本批原文总量；privateSpace 在缓存同卷时合计其峰值。
   * 返回仅原生使用的物理父目录/大小写比较键，用于本批目标去重；不预留名称或任务名额。
   * publish 仍在实际写入和发布点重查，预检成功不代表之后不会出现竞争。
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
        throw new PublicationError('invalid-request', '目标空间预检字节数无效。')
      }
      if (this.isStopped) {
        throw new PublicationError('busy', '发布适配器已停止。')
      }
      const grant = this.grants.get(request.rootId)
      if (!grant) {
        throw new PublicationError('permission-denied', '目标根没有本进程写授权。')
      }
      if (request.sizeBytes > this.maxFileBytes) {
        throw new PublicationError('resource-limit', '文件超过本机预算。')
      }
      await grant.verify()
      const location = await this.source.locateNativeDirectory(request.rootId, request.parentId)
      const peakBytes =
        bytes + (privateSpace?.device === location.identity.dev ? privateSpace.requiredBytes : 0)
      if ((await (this.io.availableBytes ?? availableBytes)(location.path)) < BigInt(peakBytes)) {
        throw new PublicationError('insufficient-space', '目标卷空间不足，无法接收本批文件。')
      }
      const names = await readdir(location.path)
      if (names.some((name) => name.toLowerCase() === request.name.toLowerCase())) {
        throw new PublicationError('name-conflict', '目标名称已存在。')
      }
      await location.verify()
      await grant.verify()
      if (this.grants.get(request.rootId) !== grant || this.isStopped) {
        throw new PublicationError('permission-denied', '本次写授权已经失效。')
      }
      return `${location.identity.dev}:${location.identity.ino}\0${request.name.toLowerCase()}`
    } catch (error) {
      throw toPublicationError(error)
    }
  }

  /**
   * 有效请求返回逐文件结果；非法字段抛 PublicationError。任何退出均关闭输入流。
   * 调用方（后续 receiver）须先校验整批归档，不能边收未验证归档边调用本接口。
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
              '未获得写授权、预算不足或已有候选等待清理。',
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
        candidateName: `.savedata-new-${randomUUID()}.tmp`,
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

  /** 仅清理本实例持有且身份仍匹配的候选；不删除已发布最终文件或未知替换物。 */
  async retryCleanup(): Promise<void> {
    const job = this.job
    if (!job) {
      return
    }
    if (job.isRunning) {
      throw new PublicationError('busy', '新文件操作尚未结束。')
    }
    const cleanup = await this.clean(job)
    if (cleanup.cleanupStatus === 'incomplete') {
      throw new PublicationError(
        'cleanup-failed',
        '候选清理失败，请核实权限和目录身份。',
        job.cleanupFailure,
      )
    }
    this.release(job)
  }

  /** 等待进行中的操作并重试候选清理；失败保留原生所有权，允许再次 stop。 */
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
      throw new PublicationError('permission-denied', '本次写授权已经失效。')
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
        throw new PublicationError('source-changed', '候选身份不可用。')
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
            message: '发布已经开始但结果未能完整核实，请重新读取目标。',
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
      throw new PublicationError('invalid-request', '目标父目录不可用。')
    }
    const names = await readdir(job.location.path)
    if (names.some((name) => name.toLowerCase() === job.request.name.toLowerCase())) {
      throw new PublicationError('name-conflict', '目标名称已存在，未覆盖已有条目。')
    }
  }

  private async assertCandidate(job: PublicationJob): Promise<void> {
    if (!job.location || !job.identity) {
      throw new PublicationError('source-changed', '候选身份不可用。')
    }
    await job.location.verify()
    const stats = await inspectLocalPath(join(job.location.path, job.candidateName))
    if (
      !stats.isFile() ||
      !hasSameIdentity(stats, job.identity) ||
      stats.nlink !== 1n ||
      stats.size !== BigInt(job.request.sizeBytes)
    ) {
      throw new PublicationError('source-changed', '候选文件已经变化。')
    }
  }

  private async stage(job: PublicationJob): Promise<void> {
    if (!job.location) {
      throw new PublicationError('invalid-request', '目标父目录不可用。')
    }
    const handle = await open(join(job.location.path, job.candidateName), 'wx', 0o600)
    job.handles.add(handle)
    job.hasCandidate = true
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.nlink !== 1n) {
      throw new PublicationError('source-changed', '候选创建身份无效。')
    }
    job.identity = getFileIdentity(stats)
    const hash = createHash('sha256')
    this.emit(job, 'staging')
    for await (const chunk of job.input) {
      if (!Buffer.isBuffer(chunk)) {
        throw new PublicationError('invalid-request', '原文流必须提供二进制数据。')
      }
      for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
        const bytes = chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
        await this.verifyGrant(job)
        if (
          job.stagedBytes + bytes.length > job.request.sizeBytes ||
          job.stagedBytes + bytes.length > this.maxFileBytes
        ) {
          throw new PublicationError('checksum-mismatch', '实际原文长度超过本次声明。')
        }
        const available = await (this.io.availableBytes ?? availableBytes)(job.location.path)
        if (available < BigInt(bytes.length)) {
          throw new PublicationError('insufficient-space', '目标卷可用空间不足。')
        }
        for (let written = 0; written < bytes.length;) {
          checkAbort(job)
          const result = await handle.write(bytes, written, bytes.length - written)
          if (result.bytesWritten <= 0) {
            throw new PublicationError('io-failure', '候选写入未取得进展。')
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
      throw new PublicationError('checksum-mismatch', '原文长度或 SHA-256 不符。')
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
        throw new PublicationError('source-changed', '最终文件身份不符。')
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
          throw new PublicationError('checksum-mismatch', '最终文件长度超过预期。')
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
        throw new PublicationError('checksum-mismatch', '最终文件内容或读取期间属性不符。')
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
          throw new PublicationError('cleanup-failed', '候选所有权未能核实。')
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
            throw new PublicationError('cleanup-failed', '候选已被替换，未删除未知条目。')
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
          message: '本次候选未完整清理，请核实目录身份和权限后重试。',
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
