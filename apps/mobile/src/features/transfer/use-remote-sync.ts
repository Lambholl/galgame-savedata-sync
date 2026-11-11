import { useEffect, useRef } from 'react'
import { observeSyncJob, syncPlanFromPreview, toShownError } from '@savedata-sync/shared'
import type {
  OperationError,
  RemoteSyncReport,
  ShownError,
  TransferDirection,
} from '@savedata-sync/shared'
import type { AndroidControlApi } from '../../platform/control-channel'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'

interface ActiveRequest {
  readonly requestId: string
  readonly deviceId: string
  preparationId: string | null
  isReady: boolean
  jobId: string | null
  isClosed: boolean
}

const PREPARATION_MS = 500
const JOB_MS = 1000
const SETTLE_MS = 2000

function failure(code: OperationError['code'], message: string) {
  return { status: 'error', error: { code, message, canRetry: false } } as const
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 响应电脑发起的复制：收到请求后扫描并回报计划，电脑确认后执行；电脑取消或断开时释放本机扫描。 */
export function useRemoteSync(
  sync: MobileSyncAdapter,
  control: AndroidControlApi,
  deviceId: string | null,
  isBusy: boolean,
  handlers: {
    readonly onScan: (requestId: string, projectId: string) => void
    readonly onStarted: (jobId: string) => void
    readonly onFailure: (error: ShownError) => void
  },
): void {
  const busy = useRef(isBusy)
  busy.current = isBusy
  const events = useRef(handlers)
  events.current = handlers
  useEffect(() => {
    if (!deviceId) {
      return
    }
    const peerId = deviceId
    let active: ActiveRequest | null = null
    let latestRequestId: string | null = null
    function report(item: ActiveRequest, value: RemoteSyncReport): void {
      if (!item.isClosed) {
        control.emit(item.deviceId, 'sync.report', value).catch(() => undefined)
      }
    }
    /** 回报扫描失败；保留原错误码，没有错误码时按读写失败回报。 */
    function fail(item: ActiveRequest, error: ShownError): void {
      const code = error.code ?? 'io-failure'
      const device = error.device ? { device: error.device } : {}
      report(item, {
        requestId: item.requestId,
        status: 'failed',
        error:
          code === 'result-unknown' || code === 'session-mismatch'
            ? { code, message: error.message, canRetry: false, ...device }
            : { code, message: error.message, canRetry: true, ...device },
      })
    }
    async function release(item: ActiveRequest): Promise<void> {
      item.isClosed = true
      if (active === item) {
        active = null
      }
      const id = item.preparationId
      if (item.jobId || !id) {
        return
      }
      item.preparationId = null
      if (!item.isReady) {
        await sync.cancelPreparation(id).catch(() => undefined)
      }
      await sync.releasePreparation(id).catch(() => undefined)
    }
    async function prepare(
      item: ActiveRequest,
      projectId: string,
      direction: TransferDirection,
    ): Promise<void> {
      let state = await sync.prepare(projectId, peerId, direction)
      item.preparationId = state.preparationId
      // 原生层返回前电脑已取消，当时 release 还不知道 ID。
      if (item.isClosed) {
        await release(item)
        return
      }
      report(item, { requestId: item.requestId, status: 'preparing' })
      while (state.status === 'preparing' && !item.isClosed) {
        await wait(PREPARATION_MS)
        state = await sync.preparation(state.preparationId)
      }
      if (item.isClosed) {
        return
      }
      if (state.status === 'ready') {
        const preview = await sync.preview(state.preparationId)
        const plan = syncPlanFromPreview(preview)
        item.isReady = true
        report(item, {
          requestId: item.requestId,
          status: 'ready',
          plan,
          backupKeepCount: preview.backupKeepCount,
        })
      } else {
        fail(item, state.error ?? { code: 'io-failure', message: 'The mobile device scan failed.' })
        await release(item)
      }
    }
    /** 每秒读取一次当前复制，结束后才接受下一次请求；卸载时停止读取，任务继续。 */
    async function watch(item: ActiveRequest, jobId: string): Promise<void> {
      for (;;) {
        await wait(JOB_MS)
        if (item.isClosed) {
          return
        }
        const copy = await sync.currentCopy().catch(() => null)
        if (copy?.state.jobId !== jobId) {
          continue
        }
        const { local, remote, remoteError } = copy.state
        if (observeSyncJob(local, remote, remoteError !== null).phase !== 'running') {
          item.isClosed = true
          if (active === item) {
            active = null
          }
          return
        }
      }
    }
    const removers = [
      control.onRequest('sync.prepare', async (from, body) => {
        if (from !== peerId) {
          return failure('session-mismatch', 'The device connection changed.')
        }
        latestRequestId = body.requestId
        // 传输刚结束时两处轮询（每秒、每 1.5 秒）还没跟上，等一下再判断，不让已结束的任务挡住新扫描。
        const deadline = Date.now() + SETTLE_MS
        while ((active?.jobId || busy.current) && Date.now() < deadline) {
          await wait(100)
        }
        if (active?.jobId) {
          return failure('busy', 'The mobile device is still running the previous transfer.')
        }
        if (active) {
          await release(active)
        }
        // 等待期间电脑已取消，或发来了更新的请求。
        if (latestRequestId !== body.requestId) {
          return { status: 'success', value: null }
        }
        if (busy.current) {
          return failure('busy', 'The mobile device is transferring or restoring. Retry later.')
        }
        const item: ActiveRequest = {
          requestId: body.requestId,
          deviceId: from,
          preparationId: null,
          isReady: false,
          jobId: null,
          isClosed: false,
        }
        active = item
        events.current.onScan(body.requestId, body.projectId)
        prepare(item, body.projectId, body.direction).catch(async (cause: unknown) => {
          fail(item, toShownError(cause))
          await release(item)
        })
        return { status: 'success', value: null }
      }),
      control.onRequest('sync.confirm', async (from, body) => {
        const item = active
        if (from !== peerId || item?.requestId !== body.requestId || !item.isReady) {
          return failure('not-found', 'The mobile device has no result for this scan. Scan again.')
        }
        const id = item.preparationId
        if (!id || item.jobId) {
          return failure('busy', 'The mobile device has already started this transfer.')
        }
        try {
          const state = await sync.execute(id, body.shouldDeleteExtras)
          item.jobId = state.jobId
          events.current.onStarted(state.jobId)
          watch(item, state.jobId).catch(() => undefined)
          return { status: 'success', value: { jobId: state.jobId } }
        } catch (cause) {
          const error = toShownError(cause)
          // 过期由发起确认的电脑提示并重新比较，移动端这边没有要处理的事。
          if (error.code !== 'plan-expired') {
            events.current.onFailure(error)
          }
          await release(item)
          return failure(error.code ?? 'io-failure', error.message)
        }
      }),
      control.onRequest('sync.cancel', async (from, body) => {
        if (from === peerId && latestRequestId === body.requestId) {
          latestRequestId = null
        }
        if (from === peerId && active?.requestId === body.requestId && !active.jobId) {
          await release(active)
        }
        return { status: 'success', value: null }
      }),
      control.onState((id, state) => {
        if (id === peerId && !state.isOpen && active && !active.jobId) {
          release(active).catch(() => undefined)
        }
      }),
    ]
    return () => {
      for (const remove of removers) {
        remove()
      }
      if (active) {
        release(active).catch(() => undefined)
      }
    }
  }, [sync, control, deviceId])
}
