import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { BATCH_RESOURCES, isFileOutcome, matchesBatchState } from '@savedata-sync/shared'
import type {
  BatchProgress,
  BatchState,
  FileOutcome,
  KnownOperationError,
  OperationError,
  ReceiveBatchRequest,
} from '@savedata-sync/shared'
import type { WindowsArchive, WindowsArchiveAdapter } from './archive-adapter.ts'
import { ArchiveCancelledError } from './archive-errors.ts'
import type { NewFilePublicationRequest, WindowsNewFilePublisher } from './new-file-publisher.ts'
import { HttpOperationError, toHttpError } from './http-errors.ts'

/** 原生接收依赖；授权和清理仍属于原有适配器，不经请求注入。 */
export interface ReceiverDependencies {
  readonly archive: Pick<WindowsArchiveAdapter, 'receive' | 'retryCleanup'>
  readonly publisher: Pick<WindowsNewFilePublisher, 'checkTarget' | 'publish' | 'retryCleanup'>
}

/** receiver 向通用注册表提交最终实际结果，清理错误独立于文件结果。 */
export interface ReceiverCompletion {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly error: OperationError | null
  readonly results: readonly FileOutcome[]
  readonly cleanupError: KnownOperationError | null
}

/** 注册表持有会话/期限/任务名额及归档；本模块只驱动接收与顺序发布。 */
export interface ReceiverHost {
  readonly signal: AbortSignal
  readonly state: () => BatchState
  readonly reason: () => KnownOperationError | null
  readonly progress: (
    stage: 'transferring' | 'verifying' | 'publishing',
    value: BatchProgress,
    results: readonly FileOutcome[],
  ) => void
  readonly networkProgress: () => void
  readonly abort: (reason: KnownOperationError) => void
  readonly ownArchive: (archive: WindowsArchive) => void
  readonly complete: (completion: ReceiverCompletion) => Promise<void>
}

function known(error: unknown): KnownOperationError {
  const value = toHttpError(error).operationError
  return value.code === 'result-unknown'
    ? { code: 'io-failure', message: '本地接收失败。', canRetry: false }
    : value
}

/** 将清单和目标映射成单文件原生请求，不将源端引用解析成本机路径。 */
export function publicationRequests(
  request: ReceiveBatchRequest,
): readonly NewFilePublicationRequest[] {
  return request.manifest.files.map((file) => {
    const target = request.targets.find((item) => item.fileId === file.fileId)
    if (!target) throw new HttpOperationError('invalid-request', '目标映射缺失。')
    return {
      fileId: file.fileId,
      rootId: request.targetRootId,
      parentId: target.parentId,
      name: target.name,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    }
  })
}

/**
 * 一次 PUT 的原生执行器；压缩体确认后独立于响应连接继续校验/发布，不重放。
 * 输入桥隔离 IncomingMessage 与归档流的所有权，原始请求失败仍可返回 JSON 控制错误。
 * 全部归档校验成功才逐文件调用发布适配；首项非成功停止，保留前项成功与明确未尝试项。
 * 资源、进度和取消规则见桌面 README；不实现 Android 或跨会话恢复。
 */
export class WindowsUploadReceiver {
  private readonly request: ReceiveBatchRequest
  private readonly dependencies: ReceiverDependencies
  private readonly host: ReceiverHost
  private readonly files: readonly NewFilePublicationRequest[]
  private readonly progress: { -readonly [Key in keyof BatchProgress]: BatchProgress[Key] }
  private readonly results: FileOutcome[] = []
  private cleanupError: KnownOperationError | null = null

  constructor(
    request: ReceiveBatchRequest,
    dependencies: ReceiverDependencies,
    host: ReceiverHost,
  ) {
    this.request = request
    this.dependencies = dependencies
    this.host = host
    this.files = publicationRequests(request)
    this.progress = {
      sourceBytesRead: 0,
      archiveBytesTransferred: 0,
      fileBytesVerified: 0,
      fileBytesPublished: 0,
      totalFileBytes: request.manifest.totalFileBytes,
      totalArchiveBytes: request.manifest.archive.sizeBytes,
      totalFiles: this.files.length,
      verifiedFiles: 0,
      publishedFiles: 0,
    }
  }

  /** 返回压缩体检查点 Promise 与完整 worker；202 不等待解包/发布完成。 */
  receive(
    input: IncomingMessage,
    response: ServerResponse,
  ): { accepted: Promise<BatchState>; worker: Promise<void> } {
    let accept: (state: BatchState) => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const accepted = new Promise<BatchState>((resolve, failed) => {
      accept = resolve
      reject = failed
    })
    const worker = this.run(input, response, accept, reject)
    return { accepted, worker }
  }

  private notify(stage: 'transferring' | 'verifying' | 'publishing'): void {
    this.host.progress(stage, { ...this.progress }, [...this.results])
  }

  private async run(
    input: IncomingMessage,
    response: ServerResponse,
    accept: (state: BatchState) => void,
    reject: (error: Error) => void,
  ): Promise<void> {
    const bridge = new PassThrough({ highWaterMark: BATCH_RESOURCES.maxBufferBytes })
    let hasMessage = false
    let hasAccepted = false
    let stage: 'transferring' | 'verifying' = 'transferring'
    const rememberError = (): void => undefined
    bridge.on('error', rememberError)
    input.on('error', rememberError)
    input.once('close', () => input.off('error', rememberError))
    const disconnected = (): void => {
      if (
        !hasMessage &&
        !(
          input.complete &&
          this.progress.archiveBytesTransferred === this.request.manifest.archive.sizeBytes
        )
      )
        this.host.abort({
          code: 'network-failure',
          message: '上传连接在收齐数据前中断。',
          canRetry: false,
        })
    }
    response.once('close', disconnected)
    input.once('aborted', disconnected)
    const stop = (): void => {
      bridge.destroy()
    }
    this.host.signal.addEventListener('abort', stop, { once: true })
    const feed = (): Promise<void> =>
      new Promise((resolve, rejectFeed) => {
        let isSettled = false
        let pushing: Promise<void> = Promise.resolve()
        const cleanup = (): void => {
          input.off('data', data)
          input.off('end', ended)
          input.off('close', closed)
          input.off('error', failed)
          this.host.signal.removeEventListener('abort', aborted)
        }
        const failed = (error: unknown): void => {
          if (isSettled) return
          isSettled = true
          input.pause()
          cleanup()
          if (!this.host.signal.aborted)
            this.host.abort(
              error instanceof HttpOperationError
                ? known(error)
                : { code: 'network-failure', message: '上传消息读取失败。', canRetry: false },
            )
          bridge.destroy(error instanceof Error ? error : new Error('上传消息失败。'))
          rejectFeed(
            error instanceof Error
              ? error
              : new HttpOperationError('io-failure', '上传消息读取失败。', error),
          )
        }
        const aborted = (): void =>
          failed(new HttpOperationError('task-conflict', '任务已经中断。'))
        const finish = (): void => {
          if (isSettled) return
          try {
            if (
              !input.complete ||
              input.rawTrailers.length > 0 ||
              this.progress.archiveBytesTransferred !== this.request.manifest.archive.sizeBytes
            )
              throw new HttpOperationError('checksum-mismatch', '上传消息未正常完整结束。')
            isSettled = true
            hasMessage = true
            cleanup()
            bridge.end()
            resolve()
          } catch (error) {
            failed(error)
          }
        }
        const push = async (chunk: unknown): Promise<void> => {
          if (!Buffer.isBuffer(chunk))
            throw new HttpOperationError('invalid-request', '上传必须使用二进制流。')
          for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
            if (this.host.signal.aborted)
              throw new HttpOperationError('task-conflict', '任务已经中断。')
            const bytes = chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
            this.progress.archiveBytesTransferred += bytes.length
            if (this.progress.archiveBytesTransferred > this.request.manifest.archive.sizeBytes)
              throw new HttpOperationError('checksum-mismatch', '上传体超过清单长度。')
            this.host.networkProgress()
            this.notify('transferring')
            if (!bridge.write(bytes)) await once(bridge, 'drain', { signal: this.host.signal })
          }
        }
        const data = (chunk: unknown): void => {
          input.pause()
          pushing = push(chunk).then(() => {
            if (!isSettled) input.resume()
          }, failed)
        }
        const ended = (): void => {
          pushing.then(finish, failed).catch(failed)
        }
        const closed = (): void => {
          if (
            input.complete &&
            this.progress.archiveBytesTransferred === this.request.manifest.archive.sizeBytes
          )
            ended()
          else failed(new HttpOperationError('network-failure', '上传消息在结束前关闭。'))
        }
        input.on('data', data)
        input.once('end', ended)
        input.once('close', closed)
        input.once('error', failed)
        this.host.signal.addEventListener('abort', aborted, { once: true })
        if (this.host.signal.aborted) aborted()
        else input.resume()
      })
    // feed 的拒绝立即转为值，归档 worker 负责收尾，避免另一条并发链出现未处理拒绝。
    const feeding = feed().then(
      () => null,
      (error: unknown) => error,
    )
    try {
      const artifact = await this.dependencies.archive.receive(this.request.manifest, bridge, {
        signal: this.host.signal,
        onArchiveStored: () => {
          if (!hasMessage)
            throw new HttpOperationError('checksum-mismatch', '上传消息尚未完整结束。')
          stage = 'verifying'
          this.notify(stage)
          hasAccepted = true
          accept(this.host.state())
        },
        onProgress: (counters) => {
          if (stage === 'verifying') {
            this.progress.fileBytesVerified = counters.verifiedFileBytes
            this.progress.verifiedFiles = counters.verifiedFiles
            this.notify(stage)
          }
        },
      })
      this.host.ownArchive(artifact)
      if (!hasAccepted) throw new HttpOperationError('invalid-archive', '接收适配器未确认压缩体。')
      await this.publish(artifact)
    } catch (error) {
      if (error && typeof error === 'object' && 'cleanupError' in error && error.cleanupError)
        this.cleanupError = {
          code: 'cleanup-failed',
          message: '私有归档未完整清理。',
          canRetry: false,
        }
      const reason = this.host.reason()
      const cancelled =
        reason === null && (this.host.signal.aborted || error instanceof ArchiveCancelledError)
      const failure = reason ?? known(error)
      if (!hasAccepted)
        reject(
          new HttpOperationError(
            cancelled ? 'task-conflict' : failure.code,
            cancelled ? '任务已取消，请查询实际结果。' : failure.message,
            error,
          ),
        )
      const results: FileOutcome[] = this.request.manifest.files.map((file) => ({
        fileId: file.fileId,
        status: 'not-attempted',
        reason: cancelled ? 'cancelled' : 'batch-invalid',
      }))
      await this.host.complete({
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : failure,
        results,
        cleanupError: this.cleanupError,
      })
    } finally {
      bridge.destroy()
      await feeding
      response.off('close', disconnected)
      input.off('aborted', disconnected)
      this.host.signal.removeEventListener('abort', stop)
      bridge.off('error', rememberError)
    }
  }

  private appendRest(
    reason: 'cancelled' | 'batch-invalid' | 'prior-failure',
  ): readonly FileOutcome[] {
    return [
      ...this.results,
      ...this.files
        .slice(this.results.length)
        .map((file) => ({ fileId: file.fileId, status: 'not-attempted' as const, reason })),
    ]
  }

  private async publish(artifact: WindowsArchive): Promise<void> {
    this.progress.fileBytesVerified = this.request.manifest.totalFileBytes
    this.progress.verifiedFiles = this.files.length
    this.notify('publishing')
    for (const file of this.files) {
      if (this.host.signal.aborted && this.host.reason() === null) {
        await this.host.complete({
          status: 'cancelled',
          error: null,
          results: this.appendRest('cancelled'),
          cleanupError: this.cleanupError,
        })
        return
      }
      let outcome: FileOutcome
      try {
        if (this.host.signal.aborted) throw new HttpOperationError('timeout', '批次已超过期限。')
        if (this.cleanupError)
          throw new HttpOperationError('cleanup-failed', '前项候选仍待清理，无法继续发布。')
        const result = await this.dependencies.publisher.publish(
          file,
          await artifact.openFile(file.fileId),
          { signal: this.host.signal },
        )
        outcome = result.outcome
        if (result.cleanupStatus === 'incomplete' || result.cleanupStatus === 'unknown')
          this.cleanupError = {
            code: 'cleanup-failed',
            message: '发布候选未完整清理，请重试。',
            canRetry: false,
          }
        if (!isFileOutcome(outcome) || outcome.fileId !== file.fileId)
          throw new HttpOperationError('result-unknown', '发布结果无法对应当前文件。')
        const temporary = this.results.concat(outcome)
        const state = this.host.state()
        if (
          state.status !== 'running' ||
          state.role !== 'receiver' ||
          !matchesBatchState(
            {
              ...state,
              fileResults: temporary,
              progress: {
                ...this.progress,
                publishedFiles: temporary.filter((item) => item.status === 'succeeded').length,
                fileBytesPublished: temporary.reduce(
                  (sum, item) => sum + (item.status === 'succeeded' ? item.bytesWritten : 0),
                  0,
                ),
              },
            },
            this.request.manifest,
            'android-to-windows',
            this.request,
          )
        )
          throw new HttpOperationError('result-unknown', '发布结果与清单或目标映射不符。')
      } catch (error) {
        const failure = toHttpError(error).operationError
        outcome =
          failure.code === 'result-unknown'
            ? { fileId: file.fileId, status: 'unknown', error: failure, residualEntries: [] }
            : { fileId: file.fileId, status: 'failed', error: failure, residualEntries: [] }
      }
      this.results.push(outcome)
      if (outcome.status === 'succeeded') {
        this.progress.fileBytesPublished += outcome.bytesWritten
        this.progress.publishedFiles++
      }
      this.notify('publishing')
      if (outcome.status !== 'succeeded') {
        const cancelled = outcome.status === 'cancelled'
        const unknown = outcome.status === 'unknown'
        const error =
          outcome.status === 'failed' || outcome.status === 'unknown' ? outcome.error : null
        await this.host.complete({
          status: cancelled ? 'cancelled' : unknown ? 'unknown' : 'failed',
          error,
          results: this.appendRest(cancelled ? 'cancelled' : 'prior-failure'),
          cleanupError: this.cleanupError,
        })
        return
      }
    }
    await this.host.complete({
      status: 'succeeded',
      error: null,
      results: [...this.results],
      cleanupError: this.cleanupError,
    })
  }
}
