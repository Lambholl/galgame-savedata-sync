import { useState } from 'react'
import { Alert, Button, Card, Modal, Progress, Space, Tag } from 'antd'
import { unwrap } from '@savedata-sync/shared'
import type { DirectoryReference, LibraryGame, SyncPlan } from '@savedata-sync/shared'
import { desktopSync } from '../../platform/sync-adapter.ts'
import { displayBytes, displayTime } from '../../components/display.ts'
import { SyncOutcomeView, SyncPlanView } from '../transfer/SyncPlanView.tsx'
import { useRestoreDetails } from '../transfer/use-sync-details.ts'
import { restoreStateTitle } from '../transfer/sync-display.ts'

/** 准备、固定计划确认及实际结果分开；关闭页面不取消原生已经接纳的恢复。 */
export function RestoreDetails({
  restoreId,
  games,
  roots,
  isActive,
  onNewTask,
  onChanged,
  onOpenBackup,
}: {
  readonly restoreId: string
  readonly games: readonly LibraryGame[]
  readonly roots: readonly DirectoryReference[]
  readonly isActive: boolean
  readonly onNewTask: (id: string) => void
  readonly onChanged: () => void
  readonly onOpenBackup?: (projectId: string, rootId: string) => void
}): React.JSX.Element {
  const resource = useRestoreDetails(restoreId),
    [isBusy, setIsBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmedPlan, setConfirmedPlan] = useState<SyncPlan | null>(null)
  const state = resource.data?.state,
    plan = resource.data?.plan
  const game = games.find((item) => item.id === state?.projectId),
    root = roots.find((item) => item.rootId === state?.rootId)
  const target = `本机电脑 · ${root?.displayPath ?? root?.displayName ?? game?.name ?? '本次记录的目录'}`
  function run(work: () => Promise<void>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    void work()
      .then(() => {
        resource.reload()
        onChanged()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '恢复操作失败。')
        resource.reload()
        onChanged()
      })
      .finally(() => setIsBusy(false))
  }
  function execute(): void {
    const value = confirmedPlan
    if (!value) {
      return
    }
    run(async () => {
      unwrap(await desktopSync().executeRestore(restoreId, value))
      setConfirmedPlan(null)
    })
  }
  function rescan(): void {
    if (!state) {
      return
    }
    run(async () => {
      unwrap(await desktopSync().releaseRestore(restoreId))
      const next = unwrap(
        await desktopSync().prepareRestore(state.projectId, state.rootId, state.backupId),
      )
      onNewTask(next.restoreId)
    })
  }
  return (
    <div className="library-stack">
      <Card
        loading={resource.isLoading}
        title={game?.name ?? '本机恢复'}
        extra={state && <Tag>{restoreStateTitle(state)}</Tag>}
      >
        <div className="library-stack">
          {(error || resource.error) && (
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
          {state?.status === 'preparing' && (
            <p>正在读取当前目录和所选备份，完成后可查看恢复计划。</p>
          )}
          {state?.error && <Alert showIcon type="error" title={state.error.message} />}
          {state?.cleanupError && (
            <Alert showIcon type="warning" title={state.cleanupError.message} />
          )}
          {state?.status === 'succeeded' && (
            <Alert
              type="success"
              showIcon
              title={state.isWorking ? '文件已恢复，正在清理资源。' : '本机恢复成功'}
            />
          )}
          {state && state.status === 'running' && (
            <>
              {state.progress.totalFiles > 0 && (
                <Progress
                  percent={Math.min(
                    100,
                    Math.floor((state.progress.publishedFiles / state.progress.totalFiles) * 100),
                  )}
                  status={resource.error ? 'normal' : 'active'}
                />
              )}
              <p>
                已写入 {state.progress.publishedFiles} / {state.progress.totalFiles}{' '}
                个文件，文件内容 {displayBytes(state.progress.fileBytesPublished)} /{' '}
                {displayBytes(state.progress.totalFileBytes)}。
              </p>
            </>
          )}
          {state && <small>状态更新：{displayTime(state.updatedAt)}</small>}
          <Space wrap>
            {state?.status === 'ready' && (
              <Button
                type="primary"
                disabled={isBusy || isActive || !plan?.canExecute || state.hasCleanupError}
                onClick={() => {
                  if (plan) {
                    setConfirmedPlan(plan)
                  }
                }}
              >
                确认恢复
              </Button>
            )}
            {state && ['preparing', 'ready', 'running'].includes(state.status) && (
              <Button
                danger
                disabled={isBusy}
                onClick={() =>
                  run(async () => {
                    unwrap(await desktopSync().cancelRestore(restoreId))
                  })
                }
              >
                {state.status === 'running' ? '取消恢复' : '取消准备'}
              </Button>
            )}
            {state?.hasCleanupError && (
              <Button
                disabled={isBusy || state.isWorking}
                onClick={() =>
                  run(async () => {
                    unwrap(await desktopSync().cleanupRestore(restoreId))
                  })
                }
              >
                重试清理
              </Button>
            )}
            {state && !state.isWorking && state.status !== 'running' && (
              <Button disabled={isBusy || state.hasCleanupError || isActive} onClick={rescan}>
                重新扫描当前目录
              </Button>
            )}
            {state && onOpenBackup && (
              <Button onClick={() => onOpenBackup(state.projectId, state.rootId)}>
                查看本机备份
              </Button>
            )}
          </Space>
        </div>
      </Card>
      {plan && (
        <Card title="恢复计划">
          <SyncPlanView plan={plan} sourceLabel="所选本机备份" targetLabel={target} />
        </Card>
      )}
      {state?.result && (
        <Card title="实际恢复结果">
          <SyncOutcomeView outcomes={state.result.outcomes} />
        </Card>
      )}
      <Modal
        open={confirmedPlan !== null}
        title="确认恢复到本机目录"
        okText="备份当前内容并恢复"
        cancelText="返回计划"
        confirmLoading={isBusy}
        okButtonProps={{ disabled: isBusy || isActive || !confirmedPlan?.canExecute }}
        cancelButtonProps={{ disabled: isBusy }}
        mask={{ closable: !isBusy }}
        closable={!isBusy}
        keyboard={!isBusy}
        onCancel={() => {
          if (!isBusy) {
            setConfirmedPlan(null)
          }
        }}
        onOk={execute}
      >
        {error && <Alert showIcon type="error" title={error} />}
        <p>{target}</p>
        <p>将所选备份写回这个目录。覆盖前会先备份当前内容，目标独有文件继续保留。</p>
        {confirmedPlan && (
          <p>
            本次写入 {confirmedPlan.transferFileCount} 个文件，内容{' '}
            {displayBytes(confirmedPlan.totalFileBytes)}。
          </p>
        )}
      </Modal>
    </div>
  )
}
