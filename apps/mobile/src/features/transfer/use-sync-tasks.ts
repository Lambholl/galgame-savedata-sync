import { useEffect, useState } from 'react'
import { observeSyncJob, toShownError } from '@savedata-sync/shared'
import type { ShownError } from '@savedata-sync/shared'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'

/** 同一应用持续查询原生任务；离开页面不取消，卸载仅停止网页轮询。 */
export function useSyncTasks(
  adapter: MobileSyncAdapter,
  projectId: string | null,
): {
  /** 全局最近的任务，活动判断和进度横条用它，不受当前游戏影响。 */
  readonly copy: MobileCopyDetails | null
  /** projectId 这款游戏自己的最近任务。 */
  readonly projectCopy: MobileCopyDetails | null
  readonly isProjectCopyLoading: boolean
  readonly restore: MobileRestoreDetails | null
  readonly errors: readonly ShownError[]
  readonly isActive: boolean
  readonly reload: () => void
} {
  const [copy, setCopy] = useState<MobileCopyDetails | null>(null)
  const [projectResult, setProjectResult] = useState<{
    readonly projectId: string
    readonly copy: MobileCopyDetails | null
  } | null>(null)
  const [restore, setRestore] = useState<MobileRestoreDetails | null>(null)
  const [errors, setErrors] = useState<readonly ShownError[]>([])
  const [version, setVersion] = useState(0)
  // 换游戏或重新进入时不沿用上次读到的记录，它可能已不是最近一次。
  useEffect(() => () => setProjectResult(null), [projectId])
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      const results = await Promise.allSettled([
        adapter.currentCopy(),
        adapter.currentRestore(),
        projectId === null ? null : adapter.latestCopy(projectId),
      ])
      if (!isCurrent) {
        return
      }
      const [copyResult, restoreResult, latestResult] = results
      if (copyResult.status === 'fulfilled') {
        setCopy(copyResult.value)
      }
      if (restoreResult.status === 'fulfilled') {
        setRestore(restoreResult.value)
      }
      if (projectId !== null && latestResult.status === 'fulfilled') {
        setProjectResult({ projectId, copy: latestResult.value })
      }
      setErrors(
        results.flatMap((result) =>
          result.status === 'rejected' ? [toShownError(result.reason)] : [],
        ),
      )
      timer = setTimeout(() => {
        poll().catch((cause: unknown) => {
          if (isCurrent) {
            setErrors([toShownError(cause)])
          }
        })
      }, 1500)
    }
    poll().catch((cause: unknown) => {
      if (isCurrent) {
        setErrors([toShownError(cause)])
      }
    })
    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [adapter, projectId, version])
  // 全局最近的任务就属于这款游戏时，它必然也是这款游戏最近的一次，不必等按游戏查询。
  const ownCopy = copy !== null && copy.preview.binding.projectId === projectId ? copy : null
  const loaded = projectResult?.projectId === projectId ? projectResult : null
  return {
    copy,
    projectCopy: ownCopy ?? loaded?.copy ?? null,
    isProjectCopyLoading: projectId !== null && ownCopy === null && loaded === null,
    restore,
    errors,
    isActive:
      (copy !== null &&
        observeSyncJob(copy.state.local, copy.state.remote, copy.state.remoteError !== null)
          .phase === 'running') ||
      Boolean(copy?.state.local.cleanupError) ||
      restore?.state.status === 'preparing' ||
      restore?.state.status === 'running' ||
      Boolean(restore?.state.result?.cleanupError),
    reload: () => setVersion((value) => value + 1),
  }
}
