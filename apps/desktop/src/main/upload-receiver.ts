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

/** 上传接收器的依赖。 */
export interface ReceiverDependencies {
  readonly archive: Pick<WindowsArchiveAdapter, 'receive' | 'retryCleanup'> &
    Partial<Pick<WindowsArchiveAdapter, 'checkReceiveSpace'>>
  readonly publisher: Pick<WindowsNewFilePublisher, 'checkTarget' | 'publish' | 'retryCleanup'>
}

/** 一次接收的最终结果，清理错误与文件结果分开。 */
export interface ReceiverCompletion {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly error: OperationError | null
  readonly results: readonly FileOutcome[]
  readonly cleanupError: KnownOperationError | null
}

/** 接收器需要的任务状态读写和归档接口。 */
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
    ? { code: 'io-failure', message: 'Local receiving failed.', canRetry: false }
    : value
}

/** 把清单和目标映射成单文件发布请求。 */
export function publicationRequests(
  request: ReceiveBatchRequest,
): readonly NewFilePublicationRequest[] {
  return request.manifest.files.map((file) => {
    const target = request.targets.find((item) => item.fileId === file.fileId)
    if (!target) {
      throw new HttpOperationError('invalid-request', 'The target mapping is missing.')
    }
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
 * 执行一次上传：压缩体确认后，校验和发布不再依赖连接。
 * 整批归档校验成功才逐个发布；遇到第一个非成功结果就停止，前面的成功项保留，其余标为未尝试。
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

  /** 开始接收，返回压缩体确认的 Promise 和整个任务的 Promise。 */
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
      ) {
        this.host.abort({
          code: 'network-failure',
          message: 'The upload connection was interrupted before all data was received.',
          canRetry: false,
        })
      }
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
          if (isSettled) {
            return
          }
          isSettled = true
          input.pause()
          cleanup()
          if (!this.host.signal.aborted) {
            this.host.abort(
              error instanceof HttpOperationError
                ? known(error)
                : {
                    code: 'network-failure',
                    message: 'Reading the upload message failed.',
                    canRetry: false,
                  },
            )
          }
          bridge.destroy(error instanceof Error ? error : new Error('The upload message failed.'))
          rejectFeed(
            error instanceof Error
              ? error
              : new HttpOperationError('io-failure', 'Reading the upload message failed.', error),
          )
        }
        const aborted = (): void =>
          failed(new HttpOperationError('task-conflict', 'The task has already been interrupted.'))
        const finish = (): void => {
          if (isSettled) {
            return
          }
          try {
            if (
              !input.complete ||
              input.rawTrailers.length > 0 ||
              this.progress.archiveBytesTransferred !== this.request.manifest.archive.sizeBytes
            ) {
              throw new HttpOperationError(
                'checksum-mismatch',
                'The upload message did not end normally and completely.',
              )
            }
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
          if (!Buffer.isBuffer(chunk)) {
            throw new HttpOperationError('invalid-request', 'Uploads must use a binary stream.')
          }
          for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
            if (this.host.signal.aborted) {
              throw new HttpOperationError(
                'task-conflict',
                'The task has already been interrupted.',
              )
            }
            const bytes = chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
            this.progress.archiveBytesTransferred += bytes.length
            if (this.progress.archiveBytesTransferred > this.request.manifest.archive.sizeBytes) {
              throw new HttpOperationError(
                'checksum-mismatch',
                'The upload body exceeds the manifest length.',
              )
            }
            this.host.networkProgress()
            this.notify('transferring')
            if (!bridge.write(bytes)) {
              await once(bridge, 'drain', { signal: this.host.signal })
            }
          }
        }
        const data = (chunk: unknown): void => {
          input.pause()
          pushing = push(chunk).then(() => {
            if (!isSettled) {
              input.resume()
            }
          }, failed)
        }
        const ended = (): void => {
          pushing.then(finish, failed).catch(failed)
        }
        const closed = (): void => {
          if (
            input.complete &&
            this.progress.archiveBytesTransferred === this.request.manifest.archive.sizeBytes
          ) {
            ended()
          } else {
            failed(
              new HttpOperationError(
                'network-failure',
                'The upload message closed before completion.',
              ),
            )
          }
        }
        input.on('data', data)
        input.once('end', ended)
        input.once('close', closed)
        input.once('error', failed)
        this.host.signal.addEventListener('abort', aborted, { once: true })
        if (this.host.signal.aborted) {
          aborted()
        } else {
          input.resume()
        }
      })
    // feed 的 reject 立即转成值，由归档任务收尾，避免另一条并发链出现未处理的 reject。
    const feeding = feed().then(
      () => null,
      (error: unknown) => error,
    )
    try {
      const artifact = await this.dependencies.archive.receive(this.request.manifest, bridge, {
        signal: this.host.signal,
        onArchiveStored: () => {
          if (!hasMessage) {
            throw new HttpOperationError('checksum-mismatch', 'The upload message is incomplete.')
          }
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
      if (!hasAccepted) {
        throw new HttpOperationError(
          'invalid-archive',
          'The receive adapter did not confirm the compressed content.',
        )
      }
      await this.publish(artifact)
    } catch (error) {
      if (error && typeof error === 'object' && 'cleanupError' in error && error.cleanupError) {
        this.cleanupError = {
          code: 'cleanup-failed',
          message: 'Private archive cleanup is incomplete.',
          canRetry: false,
        }
      }
      const reason = this.host.reason()
      const wasCancelled =
        reason === null && (this.host.signal.aborted || error instanceof ArchiveCancelledError)
      const failure = reason ?? known(error)
      if (!hasAccepted) {
        reject(
          new HttpOperationError(
            wasCancelled ? 'task-conflict' : failure.code,
            wasCancelled ? 'The task was cancelled. Query the actual result.' : failure.message,
            error,
          ),
        )
      }
      const results: FileOutcome[] = this.request.manifest.files.map((file) => ({
        fileId: file.fileId,
        status: 'not-attempted',
        reason: wasCancelled ? 'cancelled' : 'batch-invalid',
      }))
      await this.host.complete({
        status: wasCancelled ? 'cancelled' : 'failed',
        error: wasCancelled ? null : failure,
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
        if (this.host.signal.aborted) {
          throw new HttpOperationError('timeout', 'The batch exceeded its deadline.')
        }
        if (this.cleanupError) {
          throw new HttpOperationError(
            'cleanup-failed',
            'The previous candidate is awaiting cleanup. Publication cannot continue.',
          )
        }
        const result = await this.dependencies.publisher.publish(
          file,
          await artifact.openFile(file.fileId),
          { signal: this.host.signal },
        )
        outcome = result.outcome
        if (result.cleanupStatus === 'incomplete' || result.cleanupStatus === 'unknown') {
          this.cleanupError = {
            code: 'cleanup-failed',
            message: 'Publication candidate cleanup is incomplete. Retry.',
            canRetry: false,
          }
        }
        if (!isFileOutcome(outcome) || outcome.fileId !== file.fileId) {
          throw new HttpOperationError(
            'result-unknown',
            'The publication result cannot be matched to the current file.',
          )
        }
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
        ) {
          throw new HttpOperationError(
            'result-unknown',
            'The publication result does not match the manifest or target mapping.',
          )
        }
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
        const wasCancelled = outcome.status === 'cancelled'
        const isUnknown = outcome.status === 'unknown'
        const error =
          outcome.status === 'failed' || outcome.status === 'unknown' ? outcome.error : null
        await this.host.complete({
          status: wasCancelled ? 'cancelled' : isUnknown ? 'unknown' : 'failed',
          error,
          results: this.appendRest(wasCancelled ? 'cancelled' : 'prior-failure'),
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
