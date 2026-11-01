import { useState, type ReactElement } from 'react'
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationOutlined,
} from '@ant-design/icons'
import type { ShownError } from '../../result.ts'
import type { SyncWriteOutcome } from '../../sync/sync-contracts.ts'
import { formatBytes } from '../../i18n/format.ts'
import { ErrorText } from '../errors/ErrorText.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import { unsettledOutcomes } from './outcomes.ts'
import './sync-task-summary.css'

function fileName(outcome: SyncWriteOutcome): string {
  return outcome.path[outcome.path.length - 1] ?? ''
}

/** OutcomeList 的参数。 */
export interface OutcomeListProps {
  /** 逐项写入结果。 */
  readonly outcomes: readonly SyncWriteOutcome[]
  /** 清理临时文件失败的原因；没有失败时为 null。 */
  readonly cleanupError: ShownError | null
  /** 读取对端状态失败的原因；没有失败时为 null。 */
  readonly remoteError: ShownError | null
  /** 重试清理临时文件；不能重试时为 null。 */
  readonly onRetryCleanup: (() => void) | null
}

/** 传输与恢复共用的结果列表：先列需要处理的文件和清理问题，再折叠列出已写入的文件。 */
export function OutcomeList({
  outcomes,
  cleanupError,
  remoteError,
  onRetryCleanup,
}: OutcomeListProps): ReactElement {
  const t = useT()
  const locale = useLocale()
  const [isWrittenOpen, setIsWrittenOpen] = useState(false)
  const succeeded = outcomes.filter((item) => item.status === 'succeeded')
  const unsettled = unsettledOutcomes(outcomes)
  const hasAction = unsettled.length > 0 || cleanupError !== null || remoteError !== null
  return (
    <>
      {hasAction && (
        <section>
          <h3 className="ss-task-title">{t('task.needsAction')}</h3>
          <div className="ss-task-group">
            {unsettled.map((item) => (
              <div className="ss-task-row" key={item.path.join('/')}>
                <span className="ss-task-lead is-bad">
                  <CloseOutlined />
                </span>
                <span className="ss-task-body">
                  <span>{fileName(item)}</span>
                  <small className="is-bad">
                    {item.error ? (
                      <ErrorText error={item.error} context={null} />
                    ) : (
                      t(`task.outcome.${item.status}`)
                    )}
                  </small>
                </span>
              </div>
            ))}
            {cleanupError && (
              <div className="ss-task-row">
                <span className="ss-task-lead is-warn">
                  <DeleteOutlined />
                </span>
                <span className="ss-task-body">
                  <span>{t('task.cleanupFailed')}</span>
                  <small>
                    <ErrorText error={cleanupError} context={null} />
                  </small>
                </span>
                {onRetryCleanup && (
                  <button type="button" className="ss-task-link" onClick={onRetryCleanup}>
                    {t('common.retry')}
                  </button>
                )}
              </div>
            )}
            {remoteError && (
              <div className="ss-task-row">
                <span className="ss-task-lead is-warn">
                  <ExclamationOutlined />
                </span>
                <span className="ss-task-body">
                  <small>
                    <ErrorText error={remoteError} context={t('task.remoteError')} />
                  </small>
                </span>
              </div>
            )}
          </div>
        </section>
      )}
      {succeeded.length > 0 && (
        <section>
          <h3 className="ss-task-title">{t('task.written')}</h3>
          <div className="ss-task-group">
            <button
              type="button"
              className="ss-task-row"
              aria-expanded={isWrittenOpen}
              onClick={() => setIsWrittenOpen(!isWrittenOpen)}
            >
              <span className="ss-task-lead is-ok">
                <CheckOutlined />
              </span>
              <span className="ss-task-body">
                <span>{t('task.fileCount', { count: succeeded.length })}</span>
                <small>
                  {succeeded
                    .slice(0, 2)
                    .map(fileName)
                    .join(locale.startsWith('zh') || locale === 'ja-JP' ? '、' : ', ')}
                </small>
              </span>
              <DownOutlined className={`ss-task-chevron${isWrittenOpen ? ' is-open' : ''}`} />
            </button>
            {isWrittenOpen &&
              succeeded.map((item) => (
                <div className="ss-task-row is-sub" key={item.path.join('/')}>
                  <span className="ss-task-body">
                    <span>{item.path.join(' / ')}</span>
                    <small>
                      {item.action === 'create-directory'
                        ? t('task.folderCreated')
                        : t('task.verified', {
                            size:
                              item.sizeBytes === null
                                ? t('common.sizeUnknown')
                                : formatBytes(item.sizeBytes),
                          })}
                    </small>
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}
    </>
  )
}
