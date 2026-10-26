import { Alert, Button, Card, Space, Tag } from 'antd'
import type { BatchState, FileOutcome } from '@savedata-sync/shared'
import { describeState, formatBytes, formatDate } from './display'

function describeFile(result: FileOutcome): string {
  switch (result.status) {
  case 'succeeded':
    return `${result.entry.name} · 已写入 ${formatBytes(result.bytesWritten)}`
  case 'failed':
  case 'unknown':
    return `${result.error.message} · 残留 ${result.residualEntries.length} 项`
  case 'cancelled':
    return `已取消 · 残留 ${result.residualEntries.length} 项`
  case 'not-attempted':
    return `未尝试 · ${{ 'batch-invalid': '批次无效', 'prior-failure': '前项失败', cancelled: '已取消' }[result.reason]}`
  }
}

/** 本机角色的实际状态；Windows 发送完成时提示到手机核实接收结果。 */
export function TaskPanel({
  state,
  onCancel,
  isBusy,
}: {
  readonly state: BatchState
  readonly onCancel: () => void
  readonly isBusy: boolean
}): React.JSX.Element {
  return (
    <Card
      size="small"
      title={state.direction === 'android-to-windows' ? '手机 → 电脑' : '电脑 → 手机'}
      extra={
        <Tag
          color={
            state.status === 'succeeded'
              ? 'success'
              : state.status === 'failed' || state.status === 'unknown'
                ? 'error'
                : 'processing'
          }
        >
          {describeState(state)}
        </Tag>
      }
    >
      <p className="task-id">
        任务 {state.transferId} · {state.role === 'sender' ? '电脑发送端' : '电脑接收端'}
      </p>
      {state.status === 'running' ? (
        <>
          <div className="progress-grid">
            <span>源读取 {formatBytes(state.progress.sourceBytesRead)}</span>
            <span>
              归档传输 {formatBytes(state.progress.archiveBytesTransferred)} /{' '}
              {formatBytes(state.progress.totalArchiveBytes)}
            </span>
            <span>
              原文校验 {formatBytes(state.progress.fileBytesVerified)} /{' '}
              {formatBytes(state.progress.totalFileBytes)}
            </span>
            <span>
              目标写入 {formatBytes(state.progress.fileBytesPublished)} ·{' '}
              {state.progress.publishedFiles}/{state.progress.totalFiles} 文件
            </span>
          </div>
          <Button danger disabled={isBusy || state.cancelRequested} onClick={onCancel}>
            取消任务
          </Button>
        </>
      ) : (
        <Space orientation="vertical" className="full-width">
          {state.error && (
            <Alert type="error" title={`${state.error.message}（${state.error.code}）`} showIcon />
          )}
          {state.status === 'sent' && (
            <Alert type="info" title="电脑已发送，请在手机查看目标写入结果。" showIcon />
          )}
          {state.cleanupError && (
            <Alert type="warning" title={`临时文件清理：${state.cleanupError.message}`} showIcon />
          )}
        </Space>
      )}
      {state.fileResults && state.fileResults.length > 0 && (
        <ul className="file-results">
          {state.fileResults.map((result) => (
            <li key={result.fileId}>
              <span>{result.fileId}</span> {describeFile(result)}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">更新于 {formatDate(state.updatedAt)}</p>
    </Card>
  )
}
