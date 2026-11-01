import { useEffect, useState } from 'react'
import { toShownError } from '@savedata-sync/shared'
import type { ShownError } from '@savedata-sync/shared'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'

/** 同一应用持续查询原生任务；离开页面不取消，卸载仅停止网页轮询。 */
export function useSyncTasks(adapter: MobileSyncAdapter): {
  readonly copy: MobileCopyDetails | null
  readonly restore: MobileRestoreDetails | null
  readonly errors: readonly ShownError[]
  readonly isActive: boolean
  readonly reload: () => void
} {
  const [copy, setCopy] = useState<MobileCopyDetails | null>(null)
  const [restore, setRestore] = useState<MobileRestoreDetails | null>(null)
  const [errors, setErrors] = useState<readonly ShownError[]>([])
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      const results = await Promise.allSettled([adapter.currentCopy(), adapter.currentRestore()])
      if (!isCurrent) {
        return
      }
      const [copyResult, restoreResult] = results
      if (copyResult.status === 'fulfilled') {
        setCopy(copyResult.value)
      }
      if (restoreResult.status === 'fulfilled') {
        setRestore(restoreResult.value)
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
  }, [adapter, version])
  return {
    copy,
    restore,
    errors,
    isActive:
      copy?.state.local.status === 'running' ||
      copy?.state.remote?.status === 'running' ||
      Boolean(copy?.state.local.cleanupError) ||
      restore?.state.status === 'preparing' ||
      restore?.state.status === 'running' ||
      Boolean(restore?.state.result?.cleanupError),
    reload: () => setVersion((value) => value + 1),
  }
}
