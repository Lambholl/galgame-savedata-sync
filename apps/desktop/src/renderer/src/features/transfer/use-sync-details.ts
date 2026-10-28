import { useCallback, useEffect, useRef, useState } from 'react'
import { unwrap } from '@savedata-sync/shared'
import type { SyncJobRequest, SyncJobState, SyncPlan } from '@savedata-sync/shared'
import type { DesktopRestoreState } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'

interface CopyDetails {
  readonly request: SyncJobRequest
  readonly state: SyncJobState
}
interface RestoreDetails {
  readonly plan: SyncPlan | null
  readonly state: DesktopRestoreState
}
interface Resource<T> {
  readonly data: T | null
  readonly error: string
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
function copyContinues(value: CopyDetails): boolean {
  return value.state.status === 'running'
}
function restoreContinues(value: RestoreDetails): boolean {
  return value.state.isWorking
}

/** 卸载只停止页面轮询，原生任务继续；同次计划保持不变，重新进入可按 ID 恢复上下文。 */
function useResource<T>(
  id: string,
  load: (id: string, previous: T | null) => Promise<T>,
  shouldPoll: (value: T) => boolean,
): Resource<T> {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [isLoading, setIsLoading] = useState(true),
    [version, setVersion] = useState(0)
  const saved = useRef<{ id: string; value: T } | null>(null)
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  useEffect(() => {
    let isCurrent = true,
      timer: ReturnType<typeof setTimeout> | null = null
    let previous = saved.current?.id === id ? saved.current.value : null
    setData(previous)
    setError('')
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
        setError('')
        setIsLoading(false)
        if (shouldPoll(value)) {
          timer = setTimeout(() => {
            void poll().catch((cause: unknown) => {
              if (isCurrent) {
                setError(cause instanceof Error ? cause.message : '读取任务失败。')
                setIsLoading(false)
              }
            })
          }, 800)
        }
      } catch (cause) {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : '读取任务失败。')
          setIsLoading(false)
        }
      }
    }
    void poll().catch((cause: unknown) => {
      if (isCurrent) {
        setError(cause instanceof Error ? cause.message : '读取任务失败。')
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
