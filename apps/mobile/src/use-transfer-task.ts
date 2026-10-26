import { useEffect, useState } from 'react'
import type { BatchManifest, BatchState } from '@savedata-sync/shared'
import type { CurrentTransfer } from './http-transfer-bridge'
import { androidTransfers } from './http-transfers'

/** 前台查询同一任务；后台暂停界面轮询，原生通知继续持有任务，不启动/重放传输。 */
export function useTransferTask(task: CurrentTransfer | null): {
  readonly local: BatchState | null
  readonly remote: BatchState | null
  readonly manifest: BatchManifest | null
  readonly error: string
  readonly refresh: () => void
} {
  const [local, setLocal] = useState<BatchState | null>(null)
  const [remote, setRemote] = useState<BatchState | null>(null)
  const [manifest, setManifest] = useState<BatchManifest | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const transferId = task?.options.request.transferId
    setLocal((value) => (value?.transferId === transferId ? value : null))
    setRemote((value) => (value?.transferId === transferId ? value : null))
    setManifest((value) => (value?.transferId === transferId ? value : null))
    setError('')
    if (!task) {
      return
    }
    const id = task.options.request.transferId
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    let isPolling = false
    let hasManifest = false
    async function poll(): Promise<void> {
      if (!isCurrent || isPolling || document.visibilityState === 'hidden') {
        return
      }
      clearTimeout(timer)
      isPolling = true
      try {
        const localResult = await androidTransfers.query(id)
        const remoteResult = await androidTransfers.queryRemote(id, true)
        if (!isCurrent) {
          return
        }
        const errors: string[] = []
        if (localResult.status === 'success') {
          setLocal(localResult.value)
        } else if (localResult.error.code !== 'task-conflict') {
          errors.push(`手机：${localResult.error.message}（${localResult.error.code}）`)
        }
        if (remoteResult.status === 'success') {
          setRemote(remoteResult.value)
        } else if (remoteResult.error.code !== 'task-conflict') {
          errors.push(`电脑：${remoteResult.error.message}（${remoteResult.error.code}）`)
        }
        setError(errors.join('；'))
        if (!hasManifest) {
          const result = await androidTransfers.getManifest(id)
          if (isCurrent && result.status === 'success') {
            hasManifest = true
            setManifest(result.value)
          }
        }
        // 终态保留在界面；重新核实由“刷新结果”触发，避免轮询到期后覆盖已取得的结果。
        const receiver = task?.upload ? remoteResult : localResult
        if (
          receiver.status === 'success' &&
          receiver.value.status !== 'running' &&
          localResult.status === 'success' &&
          localResult.value.status !== 'running'
        ) {
          return
        }
      } catch {
        if (isCurrent) {
          setError('读取任务失败，请刷新结果。')
        }
      } finally {
        isPolling = false
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch(() => setError('刷新任务失败。'))
        }, 1200)
      }
    }
    const resume = (): void => {
      poll().catch(() => setError('恢复任务显示失败。'))
    }
    document.addEventListener('visibilitychange', resume)
    resume()
    return () => {
      isCurrent = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [task, revision])
  return { local, remote, manifest, error, refresh: () => setRevision((value) => value + 1) }
}
