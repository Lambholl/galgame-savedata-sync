import { useCallback, useEffect, useRef, useState } from 'react'
import { observeSyncJob, toShownError, unwrap } from '@savedata-sync/shared'
import type { ShownError, SyncJobRequest, SyncPlan, SyncTransferState } from '@savedata-sync/shared'
import type { DesktopRestoreState } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'

interface CopyDetails {
  readonly request: SyncJobRequest
  readonly state: SyncTransferState
}
interface RestoreDetails {
  readonly plan: SyncPlan | null
  readonly state: DesktopRestoreState
}
interface Resource<T> {
  readonly data: T | null
  readonly error: ShownError | null
  readonly isLoading: boolean
  readonly reload: () => void
}
async function readCopy(id: string, previous: CopyDetails | null): Promise<CopyDetails> {
  const api = desktopSync(),
    request = previous?.request ?? unwrap(await api.copyPlan(id))
  return { request, state: unwrap(await api.copyState(id)) }
}
async function readRestore(id: string, previous: RestoreDetails | null): Promise<RestoreDetails> {
  const api = desktopSync(),
    state = unwrap(await api.restoreState(id))
  let plan = previous?.plan ?? null
  if (!plan && state.status !== 'preparing') {
    const preview = await api.restorePlan(id)
    if (preview.status === 'success') {
      plan = preview.value
    } else if (state.status === 'ready' || state.status === 'running' || state.result !== null) {
      unwrap(preview)
    }
  }
  return { state, plan }
}
/** 结果待确认时继续读取：手机重连后还可能拿到结果。 */
function copyContinues({ state }: CopyDetails): boolean {
  return (
    state.remoteError !== null ||
    observeSyncJob(state.local, state.remote, false).phase === 'running'
  )
}
function restoreContinues(value: RestoreDetails): boolean {
  return value.state.isWorking
}

/** 读取一次任务的详情：卸载只停止页面轮询，主进程任务继续；同一次计划不变，重新进入可按 ID 恢复。 */
function useResource<T>(
  id: string,
  load: (id: string, previous: T | null) => Promise<T>,
  shouldPoll: (value: T) => boolean,
): Resource<T> {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<ShownError | null>(null),
    [isLoading, setIsLoading] = useState(true),
    [version, setVersion] = useState(0)
  const saved = useRef<{ id: string; value: T } | null>(null)
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  useEffect(() => {
    let isCurrent = true,
      timer: ReturnType<typeof setTimeout> | null = null
    let previous = saved.current?.id === id ? saved.current.value : null
    setData(previous)
    setError(null)
    setIsLoading(previous === null)
    async function poll(): Promise<void> {
      try {
        const value = await load(id, previous)
        if (!isCurrent) {
          return
        }
        previous = value
        saved.current = { id, value }
        setData(value)
        setError(null)
        setIsLoading(false)
        if (shouldPoll(value)) {
          timer = setTimeout(() => {
            void poll().catch((cause: unknown) => {
              if (isCurrent) {
                setError(toShownError(cause))
                setIsLoading(false)
              }
            })
          }, 800)
        }
      } catch (cause) {
        if (isCurrent) {
          setError(toShownError(cause))
          setIsLoading(false)
        }
      }
    }
    void poll().catch((cause: unknown) => {
      if (isCurrent) {
        setError(toShownError(cause))
        setIsLoading(false)
      }
    })
    return () => {
      isCurrent = false
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [id, load, shouldPoll, version])
  return { data, error, isLoading, reload }
}
export function useCopyDetails(id: string): Resource<CopyDetails> {
  return useResource(id, readCopy, copyContinues)
}
export function useRestoreDetails(id: string): Resource<RestoreDetails> {
  return useResource(id, readRestore, restoreContinues)
}
