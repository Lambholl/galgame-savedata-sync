import { Button, Card } from 'antd-mobile'
import type { BatchManifest, BatchState, FileOutcome } from '@savedata-sync/shared'
import type { CurrentTransfer } from './http-transfer-bridge'
import { describeState, formatBytes, formatDate } from './display'

function describeFile(result: FileOutcome): string {
  switch (result.status) {
    case 'succeeded':
      return `写入成功 · ${formatBytes(result.bytesWritten)} · ${result.entry.name}`
    case 'failed':
    case 'unknown':
      return `${result.error.message} · 残留 ${result.residualEntries.length} 项`
    case 'cancelled':
      return `已取消 · 残留 ${result.residualEntries.length} 项`
    case 'not-attempted':
      return `未尝试 · ${{ 'batch-invalid': '批次无效', 'prior-failure': '前项失败', cancelled: '已取消' }[result.reason]}`
  }
}

function StateDetails({
  title,
  state,
}: {
  readonly title: string
  readonly state: BatchState | null
}): React.JSX.Element {
  return (
    <section className="state-details">
      <h3>
        {title}：{state ? describeState(state) : '等待任务状态'}
      </h3>
      {state?.status === 'running' && (
        <div className="progress-counts">
          <span>源读取：{formatBytes(state.progress.sourceBytesRead)}</span>
          <span>
            归档传输：{formatBytes(state.progress.archiveBytesTransferred)} /{' '}
            {formatBytes(state.progress.totalArchiveBytes)}
          </span>
          <span>
            原文校验：{formatBytes(state.progress.fileBytesVerified)} /{' '}
            {formatBytes(state.progress.totalFileBytes)}
          </span>
          <span>
            目标写入：{formatBytes(state.progress.fileBytesPublished)} ·{' '}
            {state.progress.publishedFiles}/{state.progress.totalFiles} 文件
          </span>
        </div>
      )}
      {state && state.status !== 'running' && (
        <>
          {state.error && (
            <p className="error-message">
              {state.error.message}（{state.error.code}）
            </p>
          )}
          {state.cleanupError && (
            <p className="error-message">
              清理：{state.cleanupError.message}
              {title.startsWith('电脑') ? ' 请在电脑点击“重试临时文件清理”。' : ''}
            </p>
          )}
        </>
      )}
      {state && <p className="muted">更新于 {formatDate(state.updatedAt)}</p>}
    </section>
  )
}

/** 以 receiver 的逐文件结果判断写入；发送和清理信息各自保留。 */
export function TaskPanel({
  task,
  sourceLabel,
  targetLabel,
  local,
  remote,
  manifest,
  error,
  isBusy,
  onCancel,
  onRefresh,
  onCleanup,
}: {
  readonly task: CurrentTransfer
  readonly sourceLabel: string
  readonly targetLabel: string
  readonly local: BatchState | null
  readonly remote: BatchState | null
  readonly manifest: BatchManifest | null
  readonly error: string
  readonly isBusy: boolean
  readonly onCancel: () => void
  readonly onRefresh: () => void
  readonly onCleanup: () => void
}): React.JSX.Element {
  const receiver = task.upload ? remote : local
  const canCancel = !local || local.status === 'running' || remote?.status === 'running'
  return (
    <Card title={task.upload ? '手机 → 电脑 · 本次任务' : '电脑 → 手机 · 本次任务'}>
      <p className="muted">
        源：{sourceLabel}
        <br />
        目标：{targetLabel}
      </p>
      <details className="task-id">
        <summary>任务引用</summary>
        <p>{task.options.request.transferId}</p>
        <p>
          源目录：{task.options.request.sourceRootId}
          <br />
          目标目录：{task.options.targetRootId}
        </p>
      </details>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <StateDetails title={task.upload ? '手机发送端' : '手机接收端'} state={local} />
      <StateDetails title={task.upload ? '电脑接收端' : '电脑发送端'} state={remote} />
      {task.upload && local?.status === 'sent' && receiver?.status !== 'succeeded' && (
        <p className="notice">文件已发送，目标写入结果见电脑接收端。</p>
      )}
      <div className="button-row">
        <Button
          size="small"
          color="danger"
          disabled={isBusy || !canCancel || (local?.status === 'running' && local.cancelRequested)}
          onClick={onCancel}
        >
          取消任务
        </Button>
        <Button size="small" disabled={isBusy} onClick={onRefresh}>
          刷新结果
        </Button>
        <Button size="small" disabled={isBusy || local?.status === 'running'} onClick={onCleanup}>
          重试清理
        </Button>
      </div>
      <ul className="file-results">
        {task.options.targets.map((target) => {
          const source = manifest?.files.find((file) => file.fileId === target.fileId)
          const result = receiver?.fileResults?.find((file) => file.fileId === target.fileId)
          return (
            <li key={target.fileId}>
              <strong>
                {source?.sourceName ?? target.fileId} → {target.name}
              </strong>
              <p>
                {result
                  ? describeFile(result)
                  : receiver?.status === 'running'
                    ? '等待接收端结果'
                    : '接收端结果待确认'}
              </p>
              {result &&
                'residualEntries' in result &&
                result.residualEntries.map((entry) => (
                  <p className="task-id" key={entry.entryId}>
                    残留条目：{entry.entryId}
                  </p>
                ))}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
