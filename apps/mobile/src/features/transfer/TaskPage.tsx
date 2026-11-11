import { Button, ProgressBar } from 'antd-mobile'
import { Panel } from '../../components/Panel'
import { EmptyState } from '../../components/EmptyState'
import type { BatchState, FileOutcome, Translate, TransferTask } from '@savedata-sync/shared'
import { formatBytes, taskIsActive } from '@savedata-sync/shared'
import { ErrorText, useT } from '@savedata-sync/shared/ui'
import { TechnicalDetails } from './TechnicalDetails'

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
export function TaskPage({
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
    return <EmptyState description={t('task.none')} />
  }
  return (
    <div className="page-stack">
      {tasks.map((task) => {
        const receiver = task.local?.role === 'receiver' ? task.local : task.remote
        const local = task.local
        const progress = local?.status === 'running' ? local.progress : null
        const total = progress?.totalArchiveBytes
        return (
          <Panel key={task.id} title={task.title}>
            <p className="task-state">{stateTitle(t, receiver ?? local)}</p>
            {progress && (
              <>
                <ProgressBar
                  percent={
                    total
                      ? Math.min(100, Math.floor((progress.archiveBytesTransferred / total) * 100))
                      : 0
                  }
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
              <p className="notice">{t('task.unknownDetail')}</p>
            )}
            {local && local.status !== 'running' && local.error && (
              <div className="notice notice-error">
                <ErrorText error={local.error} context={null} />
              </div>
            )}
            {local && local.status !== 'running' && local.cleanupError && (
              <div className="notice notice-warning">
                <ErrorText error={local.cleanupError} context={t('task.cleanupFailed')} />
              </div>
            )}
            <div className="action-row">
              {taskIsActive(task) && (
                <Button color="danger" disabled={isBusy} onClick={() => onCancel(task.id)}>
                  {t('task.cancel')}
                </Button>
              )}
              <Button disabled={isBusy || local?.status === 'running'} onClick={onCleanup}>
                {t('task.retryCleanup')}
              </Button>
            </div>
            {receiver?.fileResults?.map((item) => (
              <div className="file-result" key={item.fileId}>
                <strong>{task.names[item.fileId] ?? item.fileId}</strong>
                <span>
                  <FileTitle result={item} />
                </span>
              </div>
            ))}
            <TechnicalDetails
              text={`${t('task.techTask')} ${task.id}\n${t('task.techLocal')}: ${stateTitle(t, local)}\n${t('task.techRemote')}: ${stateTitle(t, task.remote)}`}
            />
          </Panel>
        )
      })}
    </div>
  )
}
