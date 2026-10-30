import { useState } from 'react'
import { Button } from 'antd-mobile'
import type {
  SyncJobState,
  LibraryGame,
  LibraryPeer,
  DirectoryReference,
} from '@savedata-sync/shared'
import type {
  MobileCopyDetails,
  MobileRestoreDetails,
  MobileSyncAdapter,
} from '../../platform/sync-adapter'
import { Panel } from '../../components/Panel'
import { displayBytes, displayTime } from './display'
import { SyncOutcomeView, SyncPlanView } from './SyncPlanView'

const STAGES: Readonly<Record<SyncJobState['stage'], string>> = {
  preparing: '准备归档',
  ready: '等待接收',
  'awaiting-content': '等待内容',
  transferring: '传输中',
  verifying: '校验内容',
  'backing-up': '备份旧内容',
  writing: '写入文件',
  cleaning: '清理资源',
  done: '已结束',
}
function StateView({
  state,
  label,
}: {
  readonly state: SyncJobState
  readonly label: string
}): React.JSX.Element {
  return (
    <Panel title={label}>
      <p>
        {state.status === 'running'
          ? STAGES[state.stage]
          : {
              sent: '发送完成',
              succeeded: '写入已完成',
              failed: '失败',
              cancelled: '已取消',
              unknown: '结果待确认',
            }[state.status]}
      </p>
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
      <small>状态更新：{displayTime(state.updatedAt)}</small>
      {state.error && <p className="notice notice-error">{state.error.message}</p>}
      {state.cleanupError && (
        <p className="notice notice-error">清理未完成：{state.cleanupError.message}</p>
      )}
    </Panel>
  )
}

/** 两个角色分开展示，目标成功只依据 receiver 回读结果；失败和未知均提供重新扫描入口。 */
export function SyncTaskDetails({
  sync,
  copy,
  restore,
  games,
  peers,
  roots,
  errors,
  onChanged,
  onRescan,
  onBackup,
}: {
  readonly sync: MobileSyncAdapter
  readonly copy: MobileCopyDetails | null
  readonly restore: MobileRestoreDetails | null
  readonly games: readonly LibraryGame[]
  readonly peers: readonly LibraryPeer[]
  readonly roots: readonly DirectoryReference[]
  readonly errors: readonly string[]
  readonly onChanged: () => void
  readonly onRescan: (projectId: string, deviceId: string) => void
  readonly onBackup: (projectId: string) => void
}): React.JSX.Element {
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  function act(work: () => Promise<unknown>): void {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError('')
    work()
      .then(onChanged)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '读取任务失败。')
        onChanged()
      })
      .finally(() => setIsBusy(false))
  }
  const state = copy?.state
  const binding = copy?.preview.binding
  const game = games.find((item) => item.id === binding?.projectId)
  const peer = peers.find((item) => item.device.id === binding?.remoteDeviceId)
  const localRoot = roots.find((item) => item.rootId === binding?.localRootId)
  const remoteRoot = peer?.games.find(
    (item) => item.id === binding?.remoteProjectId && item.root?.rootId === binding.remoteRootId,
  )?.root
  const localLabel = `本机手机 · ${localRoot?.displayPath ?? localRoot?.displayName ?? '本次记录的目录'}`
  const remoteLabel = `${peer?.device.name ?? '电脑'} · ${remoteRoot?.displayPath ?? remoteRoot?.displayName ?? '本次记录的目录'}`
  const receiver =
    state?.local.role === 'receiver'
      ? state.local
      : state?.remote?.role === 'receiver'
        ? state.remote
        : null
  const isRunning = state?.local.status === 'running' || state?.remote?.status === 'running'
  return (
    <>
      {[...errors, ...(error ? [error] : [])].map((value, index) => (
        <p className="notice notice-error" role="alert" key={index}>
          当前任务读取或操作失败：{value}
        </p>
      ))}
      <Button
        disabled={isBusy}
        onClick={() =>
          act(async () => {
            await sync.currentCopy(true)
            onChanged()
          })
        }
      >
        重新读取任务状态
      </Button>
      {!copy && !restore && !errors.length && (
        <Panel>
          <p>当前没有复制或恢复任务。</p>
        </Panel>
      )}
      {copy && state && binding && (
        <>
          <Panel title={game?.name ?? '本次复制'}>
            <p>{copy.preview.direction === 'android-to-windows' ? '手机 → 电脑' : '电脑 → 手机'}</p>
            {isRunning && (
              <Button
                color="danger"
                disabled={isBusy}
                onClick={() => act(() => sync.cancelCopy(state.jobId))}
              >
                取消同步
              </Button>
            )}
            {state.local.cleanupError && (
              <Button disabled={isBusy || isRunning} onClick={() => act(() => sync.cleanupCopy())}>
                重试传输清理
              </Button>
            )}
            {!isRunning && (
              <Button
                disabled={isBusy}
                onClick={() => onRescan(binding.projectId, binding.remoteDeviceId)}
              >
                重新扫描当前目录
              </Button>
            )}
            <Button onClick={() => onBackup(binding.projectId)}>查看本机备份</Button>
          </Panel>
          <StateView
            state={state.local}
            label={state.local.role === 'receiver' ? '手机接收与写入' : '手机发送'}
          />
          {state.remote && (
            <StateView
              state={state.remote}
              label={state.remote.role === 'receiver' ? '电脑接收与写入' : '电脑发送'}
            />
          )}
          {state.remoteError && (
            <p className="notice">
              对端状态读取失败：{state.remoteError.message}。重新读取只查询本次任务。
            </p>
          )}
          {!receiver?.result && state.local.status !== 'running' && (
            <p className="notice">
              {state.local.status === 'sent'
                ? '内容已发送，目标写入结果待确认。'
                : '请查看两端状态，必要时重新扫描当前目录。'}
            </p>
          )}
          {/* 原生 jobId 与 planId 相同；同级 key 必须区分，否则轮询重渲染会遗留旧结果节点。 */}
          {receiver?.result && (
            <SyncOutcomeView key={`outcome-${state.jobId}`} result={receiver.result} />
          )}
          <SyncPlanView
            key={`plan-${copy.plan.planId}`}
            plan={copy.plan}
            sourceLabel={copy.preview.direction === 'android-to-windows' ? localLabel : remoteLabel}
            targetLabel={copy.preview.direction === 'android-to-windows' ? remoteLabel : localLabel}
          />
        </>
      )}
      {restore && (
        <Panel title="本机恢复任务">
          <p>
            {games.find((item) => item.id === restore.state.projectId)?.name ?? '本次记录的项目'} ·{' '}
            {
              {
                preparing: '准备中',
                ready: '等待确认',
                running: '恢复中',
                succeeded: '已完成',
                failed: '失败',
                cancelled: '已取消',
              }[restore.state.status]
            }
          </p>
          <Button onClick={() => onBackup(restore.state.projectId)}>查看恢复预览与实际结果</Button>
        </Panel>
      )}
    </>
  )
}
