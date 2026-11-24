import { useEffect, useState } from 'react'
import { observeSyncJob, toShownError } from '@savedata-sync/shared'
import type { ShownError } from '@savedata-sync/shared'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'

// 有任务进行时详情页和任务条显示进度，间隔长了进度会一跳一跳；读取只查原生层的状态，不经网络。
const BUSY_POLL_MS = 250
const IDLE_POLL_MS = 1500

/** 持续读取复制与恢复任务；卸载时停止读取，任务继续。 */
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
  /** 立刻读一次当前复制任务，读到后才完成；读取失败时拒绝，已有状态不变。 */
  readonly refreshCopy: () => Promise<void>
  /** 立刻读一次当前恢复任务，读到后才完成；读取失败时拒绝，已有状态不变。 */
  readonly refreshRestore: () => Promise<void>
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
      let isBusyNow = false
      if (copyResult.status === 'fulfilled') {
        setCopy(copyResult.value)
        if (
          copyResult.value &&
          observeSyncJob(
            copyResult.value.state.local,
            copyResult.value.state.remote,
            copyResult.value.state.remoteError !== null,
          ).phase === 'running'
        ) {
          isBusyNow = true
        }
      }
      if (restoreResult.status === 'fulfilled') {
        setRestore(restoreResult.value)
        if (
          restoreResult.value &&
          (restoreResult.value.state.status === 'preparing' ||
            restoreResult.value.state.status === 'running')
        ) {
          isBusyNow = true
        }
      }
      if (projectId !== null && latestResult.status === 'fulfilled') {
        setProjectResult({ projectId, copy: latestResult.value })
      }
      setErrors(
        results.flatMap((result) =>
          result.status === 'rejected' ? [toShownError(result.reason)] : [],
        ),
      )
      timer = setTimeout(
        () => {
          poll().catch((cause: unknown) => {
            if (isCurrent) {
              setErrors([toShownError(cause)])
            }
          })
        },
        isBusyNow ? BUSY_POLL_MS : IDLE_POLL_MS,
      )
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
    refreshCopy: async () => setCopy(await adapter.currentCopy()),
    refreshRestore: async () => setRestore(await adapter.currentRestore()),
  }
}
