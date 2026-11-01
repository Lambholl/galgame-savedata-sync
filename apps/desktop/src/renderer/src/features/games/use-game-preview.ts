import { useEffect, useState } from 'react'
import { toShownError, unwrap } from '@savedata-sync/shared'
import type { ShownError, SyncJobState } from '@savedata-sync/shared'
import type { DesktopCopySummary } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'

/** 只读取当前横条所需的任务状态；读取失败时保留错误供横条提示，离开页面后停止查询。 */
export function useCopyPreview(task: DesktopCopySummary | null): {
  readonly state: SyncJobState | null
  readonly error: ShownError | null
} {
  const [value, setValue] = useState<{
    id: string
    state: SyncJobState | null
    error: ShownError | null
  } | null>(null)
  const id = task?.jobId ?? null
  const updatedAt = task?.updatedAt ?? null
  useEffect(() => {
    if (!id) {
      return
    }
    let isCurrent = true
    // 快照会定时更新，因此按摘要的更新时间重新读取即可，不必另做高频轮询。
    async function read(selectedId: string): Promise<SyncJobState> {
      return unwrap(await desktopSync().copyState(selectedId))
    }
    read(id)
      .then((state) => {
        if (isCurrent) {
          setValue({ id, state, error: null })
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setValue({ id, state: null, error: toShownError(cause) })
        }
      })
    return () => {
      isCurrent = false
    }
  }, [id, updatedAt])
  return value?.id === id ? value : { state: null, error: null }
}
