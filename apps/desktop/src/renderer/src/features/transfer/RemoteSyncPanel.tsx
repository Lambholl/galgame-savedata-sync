import { useEffect, useState } from 'react'
import { Alert, Button, Space } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import type { SyncPlan, TransferDirection } from '@savedata-sync/shared'
import type { DesktopRemoteRequest } from '../../../../bridge/sync-bridge.ts'
import type { Confirmation } from '../../app/navigation.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { SyncPlanView } from './SyncPlanView.tsx'

const WAITING: readonly DesktopRemoteRequest['status'][] = ['waiting', 'preparing', 'starting']

/** 电脑发起复制：请求手机扫描，在电脑确认计划后由手机执行；手机须开着应用并已连接。 */
export function RemoteSyncPanel({
  projectId,
  gameName,
  peerId,
  direction,
  isOnline,
  isDisabled,
  sourceLabel,
  targetLabel,
  onConfirm,
  onOpenTasks,
}: {
  readonly projectId: string
  readonly gameName: string
  readonly peerId: string
  readonly direction: TransferDirection
  readonly isOnline: boolean
  readonly isDisabled: boolean
  readonly sourceLabel: string
  readonly targetLabel: string
  readonly onConfirm: (confirmation: Confirmation) => void
  readonly onOpenTasks: () => void
}): React.JSX.Element {
  const [request, setRequest] = useState<DesktopRemoteRequest | null>(null)
  const [plan, setPlan] = useState<{ readonly requestId: string; readonly value: SyncPlan } | null>(
    null,
  )
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const requestId = request?.requestId
  const hasPlan =
    request?.status === 'ready' || request?.status === 'starting' || request?.status === 'running'
  useEffect(() => {
    let isCurrent = true
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const value = unwrap(await desktopSync().remoteRequest())
        if (isCurrent) {
          setRequest(value)
        }
      } catch (cause) {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : '读取传输请求失败。')
        }
      }
      if (isCurrent) {
        timer = setTimeout(() => {
          poll().catch(() => undefined)
        }, 400)
      }
    }
    poll().catch(() => undefined)
    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [version])
  useEffect(() => {
    if (!requestId || !hasPlan || plan?.requestId === requestId) {
      return
    }
    let isCurrent = true
    desktopSync()
      .remotePlan(requestId)
      .then((result) => {
        if (isCurrent) {
          setPlan({ requestId, value: unwrap(result) })
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setError(cause instanceof Error ? cause.message : '读取手机计划失败。')
        }
      })
    return () => {
      isCurrent = false
    }
  }, [requestId, hasPlan, plan?.requestId])
  function act(work: () => Promise<DesktopRemoteRequest>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    work()
      .then(setRequest)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : '操作失败，请重试。'),
      )
      .finally(() => {
        setIsBusy(false)
        setVersion((value) => value + 1)
      })
  }
  const isOwn =
    request?.projectId === projectId && request.peerId === peerId && request.direction === direction
  const shown = isOwn ? request : null
  const isWaiting = shown !== null && WAITING.includes(shown.status)
  // 未确认的请求会被新扫描取代，只有已确认、等待手机开始的请求挡住新扫描。
  const isOther = request !== null && !isOwn && request.status === 'starting'
  const current = shown && plan?.requestId === shown.requestId ? plan.value : null
  const isLocked = isDisabled || isBusy
  function scan(): void {
    act(async () => unwrap(await desktopSync().startRemote(projectId, peerId, direction)))
  }
  function cancel(id: string): void {
    act(async () => unwrap(await desktopSync().cancelRemote(id)))
  }
  const tasks = (
    <Button size="small" onClick={onOpenTasks}>
      查看任务
    </Button>
  )
  function start(id: string, value: SyncPlan): void {
    onConfirm({
      title: direction === 'android-to-windows' ? '手机 → 电脑' : '电脑 → 手机',
      text: `${gameName}，将向目标写入本次计划。${value.shouldBackup ? '覆盖前先备份目标旧内容。' : '本次关闭覆盖前备份。'}请先退出使用该存档的游戏。`,
      okType: value.shouldBackup ? 'primary' : 'danger',
      work: async () => {
        setRequest(unwrap(await desktopSync().confirmRemote(id)))
      },
    })
  }
  return (
    <>
      {error && <Alert type="error" showIcon title={error} />}
      {isOther && <Alert type="info" showIcon title="另一项传输已确认，正在等待手机开始。" />}
      {shown?.status === 'waiting' && (
        <Alert type="info" showIcon title="等待手机响应，请保持手机应用打开。" />
      )}
      {shown?.status === 'preparing' && (
        <Alert type="info" showIcon title="手机正在扫描两端目录。" />
      )}
      {shown?.status === 'starting' && (
        <Alert type="info" showIcon title="已确认，等待手机开始传输。" />
      )}
      {shown?.status === 'running' && (
        <Alert type="info" showIcon title="手机正在传输。" action={tasks} />
      )}
      {shown?.status === 'succeeded' && (
        <Alert type="success" showIcon title="传输完成。" action={tasks} />
      )}
      {shown?.status === 'failed' && (
        <Alert
          type="error"
          showIcon
          title={shown.error?.message ?? '扫描失败，请重试。'}
          action={shown.jobId ? tasks : undefined}
        />
      )}
      {shown?.status === 'cancelled' && (
        <Alert
          type="info"
          showIcon
          title={shown.jobId ? '传输已取消。' : '扫描已取消。'}
          action={shown.jobId ? tasks : undefined}
        />
      )}
      {current && (shown?.status === 'ready' || shown?.status === 'starting') && (
        <SyncPlanView plan={current} sourceLabel={sourceLabel} targetLabel={targetLabel} />
      )}
      <Space wrap>
        {shown?.status === 'ready' ? (
          <>
            <Button
              type="primary"
              disabled={isLocked || !current?.canExecute}
              onClick={() => current && start(shown.requestId, current)}
            >
              开始传输
            </Button>
            <Button disabled={isLocked} onClick={() => cancel(shown.requestId)}>
              放弃计划
            </Button>
          </>
        ) : isWaiting && shown ? (
          <Button
            disabled={isLocked || shown.status === 'starting'}
            onClick={() => cancel(shown.requestId)}
          >
            取消扫描
          </Button>
        ) : (
          <Button
            type="primary"
            loading={isBusy}
            disabled={isLocked || !isOnline || isOther}
            onClick={scan}
          >
            扫描并预览
          </Button>
        )}
      </Space>
      {!isOnline && !shown && <Alert type="info" showIcon title="请先在手机打开应用并连接本机。" />}
    </>
  )
}
