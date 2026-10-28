import { useState } from 'react'
import { Alert, Button, Card, Progress, Space, Tag } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import type { DirectoryReference, LibraryGame, LibraryPeer } from '@savedata-sync/shared'
import type { DesktopCopySummary } from '../../../../bridge/sync-bridge.ts'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { displayBytes, displayTime } from '../../components/display.ts'
import { SyncOutcomeView, SyncPlanView } from './SyncPlanView.tsx'
import { SyncScanPanel } from './SyncScanPanel.tsx'
import { useCopyDetails } from './use-sync-details.ts'
import { syncStateTitle } from './sync-display.ts'

/** 桌面只显示本机实际观察；发送完成后，手机写入结果在手机查看。 */
export function SyncCopyDetails({
  task,
  games,
  roots,
  peers,
  onOpenBackup,
  onChanged,
}: {
  readonly task: DesktopCopySummary
  readonly games: readonly LibraryGame[]
  readonly roots: readonly DirectoryReference[]
  readonly peers: readonly LibraryPeer[]
  readonly onOpenBackup: (projectId: string, rootId: string) => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const resource = useCopyDetails(task.jobId),
    [isBusy, setIsBusy] = useState(false),
    [error, setError] = useState('')
  const state = resource.data?.state,
    request = resource.data?.request,
    plan = request?.plan
  const localRootId = plan
    ? state?.role === 'receiver'
      ? plan.target.rootId
      : plan.source.rootId
    : null
  const game = games.find((item) => item.id === task.projectId),
    root = roots.find((item) => item.rootId === localRootId),
    peer = peers.find((item) => item.device.id === task.peerId)
  const local = `本机电脑 · ${root?.displayPath ?? root?.displayName ?? game?.name ?? '本次记录的目录'}`
  const remote = `${peer?.device.name ?? '手机'} · ${peer?.games.find((item) => item.root?.rootId === (state?.role === 'receiver' ? plan?.source.rootId : plan?.target.rootId))?.name ?? '对端存档目录'}`
  function act(action: 'cancel' | 'cleanup'): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    async function work(): Promise<void> {
      if (action === 'cancel') {
        unwrap(await desktopSync().cancelCopy(task.jobId))
      } else {
        unwrap(await desktopSync().cleanupCopy(task.jobId))
      }
    }
    void work()
      .then(() => {
        resource.reload()
        onChanged()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '同步操作失败。')
        resource.reload()
        onChanged()
      })
      .finally(() => setIsBusy(false))
  }
  return (
    <div className="library-stack">
      <Card
        loading={resource.isLoading}
        title={game?.name ?? '同步任务'}
        extra={<Tag>{syncStateTitle(state ?? task)}</Tag>}
      >
        <div className="library-stack">
          {(resource.error || error) && (
            <Alert
              showIcon
              type="error"
              title={error || resource.error}
              action={
                <Button size="small" onClick={resource.reload}>
                  重新读取任务
                </Button>
              }
            />
          )}
          {state?.error && <Alert showIcon type="error" title={state.error.message} />}
          {state?.cleanupError && (
            <Alert showIcon type="warning" title={state.cleanupError.message} />
          )}
          {state?.role === 'sender' && state.status === 'sent' && (
            <Alert type="info" showIcon title="文件已发送。请在手机查看写入结果。" />
          )}
          {state && state.status === 'running' && (
            <>
              <Progress
                percent={
                  state.progress.totalArchiveBytes
                    ? Math.min(
                        100,
                        Math.floor(
                          (state.progress.archiveBytesTransferred /
                            state.progress.totalArchiveBytes) *
                            100,
                        ),
                      )
                    : 0
                }
                status={resource.error ? 'normal' : 'active'}
              />
              <p>
                归档传输 {displayBytes(state.progress.archiveBytesTransferred)} /{' '}
                {displayBytes(state.progress.totalArchiveBytes)}
              </p>
              {state.role === 'receiver' && (
                <p>
                  已校验 {state.progress.verifiedFiles} / {state.progress.totalFiles} 个文件，已写入{' '}
                  {state.progress.publishedFiles} 个文件。
                </p>
              )}
            </>
          )}
          {state && <small>状态更新：{displayTime(state.updatedAt)}</small>}
          <Space wrap>
            {(state ?? task).status === 'running' && (
              <Button danger disabled={isBusy} onClick={() => act('cancel')}>
                取消同步
              </Button>
            )}
            {(state ? Boolean(state.cleanupError) : task.hasCleanupError) && (
              <Button
                disabled={isBusy || (state ?? task).status === 'running'}
                onClick={() => act('cleanup')}
              >
                重试清理
              </Button>
            )}
            {state?.role === 'receiver' && plan && (
              <Button onClick={() => onOpenBackup(task.projectId, plan.target.rootId)}>
                查看本机备份
              </Button>
            )}
          </Space>
        </div>
      </Card>
      {plan && (
        <Card title="本次确认计划">
          <SyncPlanView
            plan={plan}
            sourceLabel={state?.role === 'receiver' ? remote : local}
            targetLabel={state?.role === 'receiver' ? local : remote}
          />
        </Card>
      )}
      {state?.result && (
        <Card title="本机实际写入结果">
          <SyncOutcomeView outcomes={state.result.outcomes} />
        </Card>
      )}
      {localRootId && (
        <SyncScanPanel rootId={localRootId} isDisabled={isBusy || state?.status === 'running'} />
      )}
    </div>
  )
}
