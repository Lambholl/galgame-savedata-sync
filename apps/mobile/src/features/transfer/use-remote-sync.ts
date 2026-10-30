import { useEffect, useRef } from 'react'
import { syncPlanFromPreview } from '@savedata-sync/shared'
import type { OperationError, RemoteSyncReport, TransferDirection } from '@savedata-sync/shared'
import type { AndroidControlApi } from '../../platform/control-channel'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import { transferOutcome } from './transfer-feedback'

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

function failure(code: OperationError['code'], message: string) {
  return { status: 'error', error: { code, message, canRetry: false } } as const
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 电脑发起的复制：经控制通道收到请求后在手机扫描并回报计划，电脑确认后由手机执行，
 * 结束时回报最终结果。电脑取消或断开时释放本机扫描；已开始的传输交给任务页。
 */
export function useRemoteSync(
  sync: MobileSyncAdapter,
  control: AndroidControlApi,
  deviceId: string | null,
  isBusy: boolean,
  handlers: {
    readonly onScan: (projectId: string) => void
    readonly onStarted: (jobId: string) => void
    readonly onFailure: (message: string) => void
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
    function report(item: ActiveRequest, value: RemoteSyncReport): void {
      if (!item.isClosed) {
        control.emit(item.deviceId, 'sync.report', value).catch(() => undefined)
      }
    }
    function fail(item: ActiveRequest, message: string): void {
      report(item, {
        requestId: item.requestId,
        status: 'failed',
        error: { code: 'io-failure', message, canRetry: true },
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
      report(item, { requestId: item.requestId, status: 'preparing' })
      while (state.status === 'preparing' && !item.isClosed) {
        await wait(PREPARATION_MS)
        state = await sync.preparation(state.preparationId)
      }
      if (item.isClosed) {
        return
      }
      if (state.status === 'ready') {
        const plan = syncPlanFromPreview(await sync.preview(state.preparationId))
        item.isReady = true
        report(item, { requestId: item.requestId, status: 'ready', plan })
      } else {
        fail(item, state.error?.message ?? '手机扫描失败，请重新扫描。')
        await release(item)
      }
    }
    /** 每秒读取一次当前复制，结束后回报结果；页面卸载即停止，不影响原生任务。 */
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
        const result = transferOutcome(copy.state)
        if (result) {
          report(item, { requestId: item.requestId, status: 'finished', jobId, ...result })
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
          return failure('session-mismatch', '设备连接已变化。')
        }
        if (active?.jobId) {
          return failure('busy', '手机还在执行上一次传输。')
        }
        if (active) {
          await release(active)
        }
        if (busy.current) {
          return failure('busy', '手机正在传输或恢复，请稍后重试。')
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
        events.current.onScan(body.projectId)
        prepare(item, body.projectId, body.direction).catch(async (cause: unknown) => {
          fail(item, cause instanceof Error ? cause.message : '手机扫描失败，请重新扫描。')
          await release(item)
        })
        return { status: 'success', value: null }
      }),
      control.onRequest('sync.confirm', async (from, body) => {
        const item = active
        if (from !== peerId || item?.requestId !== body.requestId || !item.isReady) {
          return failure('not-found', '手机没有这次扫描的结果，请重新扫描。')
        }
        const id = item.preparationId
        if (!id || item.jobId) {
          return failure('busy', '手机已经开始这次传输。')
        }
        try {
          const state = await sync.execute(id)
          item.jobId = state.jobId
          events.current.onStarted(state.jobId)
          watch(item, state.jobId).catch(() => undefined)
          return { status: 'success', value: { jobId: state.jobId } }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : '手机开始传输失败。'
          events.current.onFailure(message)
          await release(item)
          return failure('io-failure', message)
        }
      }),
      control.onRequest('sync.cancel', async (from, body) => {
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
