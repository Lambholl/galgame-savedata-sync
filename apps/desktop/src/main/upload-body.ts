import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { BATCH_RESOURCES } from '@savedata-sync/shared'
import type { KnownOperationError } from '@savedata-sync/shared'
import { HttpOperationError, toHttpError } from './http-errors.ts'

interface UploadBodyHost {
  readonly signal: AbortSignal
  readonly length: number
  readonly progress: (bytes: number) => void
  readonly abort: (error: KnownOperationError) => void
}
/** 输入请求和归档流分别拥有生命周期；接收方须在 finally destroy 并等待 settled、close。 */
export interface UploadBody {
  readonly stream: PassThrough
  readonly isComplete: () => boolean
  readonly settled: Promise<unknown>
  readonly close: () => void
}
/** 完整定长消息结束后，响应断开不再中止归档校验及写入；未收齐则取消本次任务。 */
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
    if (!hasMessage && !(input.complete && bytes === host.length)) {
      host.abort({
        code: 'network-failure',
        message: '上传连接在收齐数据前中断。',
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
          ? { code: 'network-failure', message: '上传消息读取失败。', canRetry: false }
          : error,
      )
    }
    stream.destroy(cause instanceof Error ? cause : new Error('上传消息读取失败。'))
    // 所有错误先转成值；归档消费者负责判定根错误，feed 不产生独立未处理拒绝。
    resolveFeed(cause)
  }
  const aborted = (): void => failed(new HttpOperationError('task-conflict', '任务已中断。'))
  const finish = (): void => {
    if (isSettled) {
      return
    }
    if (!input.complete || input.rawTrailers.length > 0 || bytes !== host.length) {
      failed(new HttpOperationError('checksum-mismatch', '上传消息未正常完整结束。'))
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
      throw new HttpOperationError('invalid-request', '上传必须使用二进制流。')
    }
    for (let offset = 0; offset < chunk.length; offset += BATCH_RESOURCES.maxBufferBytes) {
      if (host.signal.aborted) {
        throw new HttpOperationError('task-conflict', '任务已中断。')
      }
      const part = chunk.subarray(offset, offset + BATCH_RESOURCES.maxBufferBytes)
      bytes += part.length
      if (bytes > host.length) {
        throw new HttpOperationError('checksum-mismatch', '上传体超过清单长度。')
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
    if (input.complete && bytes === host.length) {
      ended()
    } else {
      failed(new HttpOperationError('network-failure', '上传消息在结束前关闭。'))
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
        failed(new HttpOperationError('network-failure', '上传接收已结束。'))
      }
      response.off('close', disconnected)
      input.off('aborted', disconnected)
      stream.destroy()
    },
  }
}
