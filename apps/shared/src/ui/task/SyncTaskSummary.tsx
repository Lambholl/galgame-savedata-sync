import { useState, type ReactElement } from 'react'
import {
  ArrowRightOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationOutlined,
  MinusOutlined,
} from '@ant-design/icons'
import type { SyncWriteOutcome } from '../../sync/sync-contracts.ts'
import type { SyncJobState } from '../../sync/sync-job-contracts.ts'
import { formatBytes, formatDateTime } from '../../i18n/format.ts'
import type { PlanEndpoint } from '../plan/SyncPlanSummary.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import './sync-task-summary.css'

/** SyncTaskSummary 的参数。 */
export interface SyncTaskSummaryProps {
  /** 本次传输的游戏名。 */
  readonly gameName: string
  /** 写出内容的一端。 */
  readonly source: PlanEndpoint
  /** 被写入的一端。 */
  readonly target: PlanEndpoint
  /** 本机角色的任务状态。 */
  readonly local: SyncJobState
  /** 对端角色的任务状态；读不到时为 null。 */
  readonly remote: SyncJobState | null
  /** 读取对端状态失败的原因；没有失败时为 null。 */
  readonly remoteError: string | null
  /** 重试清理临时文件；本端不能重试时为 null。 */
  readonly onRetryCleanup: (() => void) | null
}

type UnsettledOutcome = SyncWriteOutcome & {
  readonly status: Exclude<SyncWriteOutcome['status'], 'succeeded'>
}

type Phase = 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'unknown'

const STEPS = [
  'task.step.pack',
  'task.step.transfer',
  'task.step.verify',
  'task.step.backup',
  'task.step.write',
] as const

const STEP_OF: Readonly<Record<SyncJobState['stage'], number>> = {
  preparing: 0,
  ready: 1,
  'awaiting-content': 1,
  transferring: 1,
  verifying: 2,
  'backing-up': 3,
  writing: 4,
  cleaning: 4,
  done: 5,
}

function ratio(done: number, total: number | null): number {
  return total ? Math.min(1, Math.max(0, done / total)) : 0
}

/** 当前步骤内的完成比例，用于估算整体进度。 */
function stepFraction(state: SyncJobState, step: number): number {
  const progress = state.progress
  if (step === 1) {
    return ratio(progress.archiveBytesTransferred, progress.totalArchiveBytes)
  }
  if (step === 2) {
    return ratio(progress.verifiedFiles, progress.totalFiles)
  }
  if (step === 4) {
    return ratio(progress.publishedFiles, progress.totalFiles)
  }
  return 0
}

function fileName(outcome: SyncWriteOutcome): string {
  return outcome.path[outcome.path.length - 1] ?? ''
}

/**
 * 传输详情：先给结论（进度环或成功/部分完成/失败），再给五步进度和需要处理的文件；
 * 两端角色的内部状态只放在折叠的“技术详情”里。
 */
export function SyncTaskSummary({
  gameName,
  source,
  target,
  local,
  remote,
  remoteError,
  onRetryCleanup,
}: SyncTaskSummaryProps): ReactElement {
  const t = useT()
  const locale = useLocale()
  const [isWrittenOpen, setIsWrittenOpen] = useState(false)
  const receiver = local.role === 'receiver' ? local : remote?.role === 'receiver' ? remote : null
  const states = remote ? [local, remote] : [local]
  const result = receiver?.result ?? null
  const outcomes = result?.outcomes ?? []
  const succeeded = outcomes.filter((item) => item.status === 'succeeded')
  const unsettled = outcomes.filter((item): item is UnsettledOutcome => item.status !== 'succeeded')
  let phase: Phase
  if (states.some((item) => item.status === 'running')) {
    phase = 'running'
  } else if (result) {
    phase =
      result.error && succeeded.length === 0
        ? 'failed'
        : result.error || unsettled.length > 0
          ? 'partial'
          : 'done'
  } else if (states.some((item) => item.status === 'cancelled')) {
    phase = 'cancelled'
  } else if (states.some((item) => item.status === 'failed')) {
    phase = 'failed'
  } else {
    phase = 'unknown'
  }
  const leading = receiver ?? local
  const step = phase === 'done' ? 5 : STEP_OF[leading.stage]
  const percent = Math.round(((step + stepFraction(leading, step)) / STEPS.length) * 100)
  const error = result?.error ?? states.find((item) => item.error)?.error ?? null
  const cleanupError = result?.cleanupError ?? local.cleanupError
  const files = leading.progress
  let hero: ReactElement
  if (phase === 'running') {
    const radius = 64
    const circle = 2 * Math.PI * radius
    hero = (
      <>
        <div className="ss-ring">
          <svg viewBox="0 0 150 150" aria-hidden="true">
            <circle className="is-track" cx="75" cy="75" r={radius} />
            <circle
              className="is-fill"
              cx="75"
              cy="75"
              r={radius}
              strokeDasharray={circle}
              strokeDashoffset={circle * (1 - percent / 100)}
            />
          </svg>
          <div>
            <b>{percent}%</b>
            <span>{t(`task.stage.${leading.stage}`)}</span>
          </div>
        </div>
        {files.totalFiles > 0 && (
          <p>
            {t('task.files', { done: files.publishedFiles, total: files.totalFiles })} ·{' '}
            {formatBytes(files.fileBytesPublished)} / {formatBytes(files.totalFileBytes)}
          </p>
        )}
      </>
    )
  } else {
    const verdict = {
      done: { tone: 'ok', icon: <CheckOutlined />, title: t('task.done') },
      partial: { tone: 'warn', icon: <ExclamationOutlined />, title: t('task.partial') },
      failed: { tone: 'bad', icon: <CloseOutlined />, title: t('task.failed') },
      cancelled: { tone: 'muted', icon: <MinusOutlined />, title: t('task.cancelled') },
      unknown: { tone: 'warn', icon: <ExclamationOutlined />, title: t('task.unknown') },
    }[phase]
    let detail: string | null = null
    if (phase === 'done') {
      detail = t('task.doneDetail', { count: succeeded.length })
      if (result?.backupId) {
        detail += ` · ${t('task.backedUp')}`
      }
    } else if (phase === 'partial') {
      detail = t('task.partialDetail', { ok: succeeded.length, failed: unsettled.length })
    } else if (phase === 'failed') {
      detail = error?.message ?? null
    } else if (phase === 'unknown') {
      detail = t('task.unknownDetail')
    }
    hero = (
      <>
        <div className={`ss-verdict is-${verdict.tone}`}>{verdict.icon}</div>
        <h2>{verdict.title}</h2>
        {detail && <p>{detail}</p>}
      </>
    )
  }
  const hasAction = unsettled.length > 0 || cleanupError !== null || remoteError !== null
  return (
    <div className="ss-task">
      <div className="ss-task-hero">
        <span className="ss-task-route">
          {gameName} · {source.name} <ArrowRightOutlined /> {target.name}
        </span>
        {hero}
      </div>
      {(phase === 'running' || phase === 'done') && (
        <div className="ss-steps">
          <span className="ss-steps-bar" style={{ width: `${(Math.min(step, 4) / 4) * 80}%` }} />
          {STEPS.map((key, index) => (
            <div
              key={key}
              className={`ss-step${index < step ? ' is-done' : index === step ? ' is-now' : ''}`}
            >
              <i>{index < step && <CheckOutlined />}</i>
              {t(key)}
            </div>
          ))}
        </div>
      )}
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
                    {item.error?.message ?? t(`task.outcome.${item.status}`)}
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
                  <small>{cleanupError.message}</small>
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
                  <small>{t('task.remoteError', { message: remoteError })}</small>
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
      <details className="ss-task-tech">
        <summary>{t('task.tech')}</summary>
        <p>
          {local.jobId} · {t('task.techLocal')} {local.role}/{local.status}/{local.stage}
          {remote &&
            ` · ${t('task.techRemote')} ${remote.role}/${remote.status}/${remote.stage}`} ·{' '}
          {t('task.techUpdated')} {formatDateTime(local.updatedAt, locale)}
        </p>
      </details>
    </div>
  )
}
