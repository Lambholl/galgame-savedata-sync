import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { BATCH_RESOURCES } from '@savedata-sync/shared'
import type { KnownOperationError } from '@savedata-sync/shared'
import { HttpOperationError, toHttpError } from './http-errors.ts'

interface UploadBodyHost {
  readonly signal: AbortSignal
  /** 请求体的长度上限。 */
  readonly maxBytes: number
  readonly progress: (bytes: number) => void
  readonly abort: (error: KnownOperationError) => void
}
/** 上传输入：用完后要 destroy，并等待 settled 和 close。 */
export interface UploadBody {
  readonly stream: PassThrough
  readonly isComplete: () => boolean
  readonly settled: Promise<unknown>
  readonly close: () => void
}
/**
 * 打开上传输入。请求体收齐前连接断开或读取失败时，以 network-failure 调用 host.abort。
 * 请求体收齐后连接断开，任务照常进行。
 */
export function openUploadBody(
  input: IncomingMessage,
  response: ServerResponse,
  host: UploadBodyHost,
): UploadBody {
  const stream = new PassThrough({ highWaterMark: BATCH_RESOURCES.maxBufferBytes })
  let bytes = 0,
    hasMessage = false,
    isSettled = false
  let pushing: Promise<void> = Promise.resolve()
  const rememberError = (): void => undefined
  stream.on('error', rememberError)
  input.on('error', rememberError)
  input.once('close', () => input.off('error', rememberError))
  const disconnected = (): void => {
    if (!hasMessage && !input.complete) {
      host.abort({
        code: 'network-failure',
        message: 'The upload connection was interrupted before all data was received.',
        canRetry: false,
      })
    }
  }
  response.once('close', disconnected)
  input.once('aborted', disconnected)
  let resolveFeed: (value: unknown) => void = () => undefined
  const settled = new Promise<unknown>((resolve) => {
    resolveFeed = resolve
  })
  const cleanup = (): void => {
    input.off('data', data)
    input.off('end', ended)
    input.off('close', closed)
    input.off('error', failed)
    host.signal.removeEventListener('abort', aborted)
  }
  const failed = (cause: unknown): void => {
    if (isSettled) {
      return
    }
    isSettled = true
    input.pause()
    cleanup()
    if (!host.signal.aborted) {
      const error = toHttpError(cause).operationError
      host.abort(
        error.code === 'result-unknown'
          ? {
              code: 'network-failure',
              message: 'Reading the upload message failed.',
              canRetry: false,
            }
          : error,
      )
    }
    stream.destroy(cause instanceof Error ? cause : new Error('Reading the upload message failed.'))
    // 错误转成值交给归档消费者判定根错误，feed 自身不产生未处理的 reject。
    resolveFeed(cause)
  }
  const aborted = (): void =>
    failed(new HttpOperationError('task-conflict', 'The task has been interrupted.'))
  const finish = (): void => {
    if (isSettled) {
      return
    }
    if (!input.complete || input.rawTrailers.length > 0) {
      failed(
        new HttpOperationError(
          'checksum-mismatch',
          'The upload message did not end normally and completely.',
        ),
      )
      return
    }
    isSettled = true
    hasMessage = true
    cleanup()
    stream.end()
    resolveFeed(null)
  }
  const push = async (chunk: unknown): Promise<void> => {
    if (!Buffer.isBuffer(chunk)) {
      throw new HttpOperationError('invalid-request', 'Uploads must use a binary stream.')
    }
    for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
      if (host.signal.aborted) {
        throw new HttpOperationError('task-conflict', 'The task has been interrupted.')
      }
      const part = chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
      bytes += part.length
      if (bytes > host.maxBytes) {
        throw new HttpOperationError('resource-limit', 'The upload body exceeds the limit.')
      }
      host.progress(bytes)
      if (!stream.write(part)) {
        await once(stream, 'drain', { signal: host.signal })
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
    if (input.complete) {
      ended()
    } else {
      failed(
        new HttpOperationError('network-failure', 'The upload message closed before completion.'),
      )
    }
  }
  input.on('data', data)
  input.once('end', ended)
  input.once('close', closed)
  input.once('error', failed)
  host.signal.addEventListener('abort', aborted, { once: true })
  if (host.signal.aborted) {
    aborted()
  } else {
    input.resume()
  }
  return {
    stream,
    settled,
    isComplete: () => hasMessage,
    close: () => {
      if (!isSettled) {
        failed(new HttpOperationError('network-failure', 'Upload receiving has ended.'))
      }
      response.off('close', disconnected)
      input.off('aborted', disconnected)
      stream.destroy()
    },
  }
}
