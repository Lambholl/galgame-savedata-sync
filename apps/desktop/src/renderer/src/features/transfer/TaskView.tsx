import { Alert, Button, Card, Empty, Progress, Space, Tag } from 'antd'
import type { BatchState, FileOutcome, Translate, TransferTask } from '@savedata-sync/shared'
import { formatBytes, taskIsActive } from '@savedata-sync/shared'
import { ErrorText, useT } from '@savedata-sync/shared/ui'
import { TechnicalDetails } from './TechnicalDetails.tsx'

function stateTitle(t: Translate, state: BatchState | null): string {
  if (!state) {
    return t('task.loading')
  }
  if (state.status === 'running') {
    return t(`task.stage.${state.stage === 'publishing' ? 'writing' : state.stage}`)
  }
  return {
    sent: t('task.sent'),
    succeeded: t('task.done'),
    failed: t('task.failed'),
    cancelled: t('task.cancelled'),
    unknown: t('task.unknown'),
  }[state.status]
}
function FileTitle({ result }: { readonly result: FileOutcome }): React.JSX.Element {
  const t = useT()
  if (result.status === 'failed' || result.status === 'unknown') {
    return <ErrorText error={result.error} context={null} />
  }
  return (
    <>
      {result.status === 'succeeded'
        ? t('task.written')
        : t(`task.outcome.${result.status === 'cancelled' ? 'cancelled' : 'not-attempted'}`)}
    </>
  )
}
/** 一次批量传输的详情；以接收端结果判定成功，发送完成后缺少回执时显示待确认。 */
export function TaskView({
  tasks,
  isBusy,
  onCancel,
  onCleanup,
}: {
  readonly tasks: readonly TransferTask[]
  readonly isBusy: boolean
  readonly onCancel: (id: string) => void
  readonly onCleanup: () => void
}): React.JSX.Element {
  const t = useT()
  if (!tasks.length) {
    return <Empty description={t('task.none')} />
  }
  return (
    <div className="library-stack">
      {tasks.map((task) => {
        const receiver = task.local?.role === 'receiver' ? task.local : task.remote
        const local = task.local
        const progress = local?.status === 'running' ? local.progress : null
        const total = progress?.totalArchiveBytes
        return (
          <Card
            key={task.id}
            title={task.title}
            extra={<Tag>{stateTitle(t, receiver ?? local)}</Tag>}
          >
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
                  {t('task.archiveProgress', {
                    done: formatBytes(progress.archiveBytesTransferred),
                    total:
                      total === null || total === undefined
                        ? t('common.sizeUnknown')
                        : formatBytes(total),
                  })}
                </p>
                <p>
                  {t('task.files', { done: progress.publishedFiles, total: progress.totalFiles })}
                </p>
              </>
            )}
            {local?.status === 'sent' && receiver?.status !== 'succeeded' && (
              <Alert type="info" title={t('task.unknownDetail')} showIcon />
            )}
            {local && local.status !== 'running' && local.error && (
              <Alert
                type="error"
                title={<ErrorText error={local.error} context={null} />}
                showIcon
              />
            )}
            {local && local.status !== 'running' && local.cleanupError && (
              <Alert
                type="warning"
                title={<ErrorText error={local.cleanupError} context={t('task.cleanupFailed')} />}
                showIcon
              />
            )}
            <Space wrap className="library-task-actions">
              {taskIsActive(task) && (
                <Button danger disabled={isBusy} onClick={() => onCancel(task.id)}>
                  {t('task.cancel')}
                </Button>
              )}
              <Button disabled={isBusy || local?.status === 'running'} onClick={onCleanup}>
                {t('task.retryCleanup')}
              </Button>
            </Space>
            {receiver?.fileResults?.map((item) => (
              <div className="library-file-result" key={item.fileId}>
                <strong>{task.names[item.fileId] ?? item.fileId}</strong>
                <span>
                  <FileTitle result={item} />
                </span>
              </div>
            ))}
            <TechnicalDetails
              text={`${t('task.techTask')} ${task.id}\n${t('task.techLocal')}: ${stateTitle(t, local)}\n${t('task.techRemote')}: ${stateTitle(t, task.remote)}`}
            />
          </Card>
        )
      })}
    </div>
  )
}
