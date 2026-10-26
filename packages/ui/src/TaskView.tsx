import { Alert, Button, Card, Empty, Progress, Space, Tag } from 'antd'
import type { BatchState, FileOutcome } from '@savedata-sync/shared'
import { displayBytes, taskIsActive } from './api.ts'
import type { UiTask } from './api.ts'

function stateTitle(state: BatchState | null): string {
  if (!state) return '正在读取任务'
  if (state.status === 'running')
    return {
      preparing: '准备文件',
      ready: '等待领取',
      'awaiting-content': '等待接收',
      transferring: '传输中',
      verifying: '校验内容',
      publishing: '写入目标',
      cleaning: '清理临时文件',
    }[state.stage]
  return {
    sent: '发送完成',
    succeeded: '目标写入成功',
    failed: '失败',
    cancelled: '已取消',
    unknown: '结果待确认',
  }[state.status]
}
function fileTitle(result: FileOutcome): string {
  return result.status === 'succeeded'
    ? '写入成功'
    : result.status === 'failed' || result.status === 'unknown'
      ? result.error.message
      : result.status === 'cancelled'
        ? '已取消'
        : '未尝试'
}
/** 以接收端结果显示成功；发送完成后缺少回执时保留待确认状态。 */
export function TaskView({
  tasks,
  isBusy,
  onCancel,
  onCleanup,
}: {
  readonly tasks: readonly UiTask[]
  readonly isBusy: boolean
  readonly onCancel: (id: string) => void
  readonly onCleanup: () => void
}): React.JSX.Element {
  if (!tasks.length) return <Empty description="暂无传输任务" />
  return (
    <div className="library-stack">
      {tasks.map((task) => {
        const receiver = task.local?.role === 'receiver' ? task.local : task.remote
        const local = task.local
        const progress = local?.status === 'running' ? local.progress : null
        const total = progress?.totalArchiveBytes
        return (
          <Card key={task.id} title={task.title} extra={<Tag>{stateTitle(receiver ?? local)}</Tag>}>
            {progress && (
              <>
                <Progress
                  percent={
                    total
                      ? Math.min(100, Math.floor((progress.archiveBytesTransferred / total) * 100))
                      : 0
                  }
                  status="active"
                />
                <p>
                  归档传输 {displayBytes(progress.archiveBytesTransferred)} /{' '}
                  {displayBytes(total ?? null)}
                </p>
                <p>
                  目标写入 {progress.publishedFiles} / {progress.totalFiles} 个文件
                </p>
              </>
            )}
            {local?.status === 'sent' && receiver?.status !== 'succeeded' && (
              <Alert type="info" title="文件已发送，请在接收端核实写入结果。" showIcon />
            )}
            {local && local.status !== 'running' && local.error && (
              <Alert type="error" title={local.error.message} showIcon />
            )}
            {local && local.status !== 'running' && local.cleanupError && (
              <Alert type="warning" title={local.cleanupError.message} showIcon />
            )}
            <Space wrap className="library-task-actions">
              {taskIsActive(task) && (
                <Button danger disabled={isBusy} onClick={() => onCancel(task.id)}>
                  取消传输
                </Button>
              )}
              <Button disabled={isBusy || local?.status === 'running'} onClick={onCleanup}>
                重试清理
              </Button>
            </Space>
            {receiver?.fileResults?.map((item) => (
              <div className="library-file-result" key={item.fileId}>
                <strong>{task.names[item.fileId] ?? item.fileId}</strong>
                <span>{fileTitle(item)}</span>
              </div>
            ))}
            <details>
              <summary>任务详情</summary>
              <small>{task.id}</small>
              <p>本机：{stateTitle(local)}</p>
              <p>对端：{stateTitle(task.remote)}</p>
            </details>
          </Card>
        )
      })}
    </div>
  )
}
