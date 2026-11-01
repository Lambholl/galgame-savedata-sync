import type { ReactElement, ReactNode } from 'react'
import { ArrowRightOutlined, CheckOutlined } from '@ant-design/icons'
import type { ShownError } from '../../result.ts'
import { ErrorText } from '../errors/ErrorText.tsx'
import type { SyncJobState } from '../../sync/sync-job-contracts.ts'
import { formatBytes, formatDateTime } from '../../i18n/format.ts'
import type { PlanEndpoint } from '../plan/SyncPlanSummary.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import { OutcomeList } from './OutcomeList.tsx'
import { unsettledOutcomes } from './outcomes.ts'
import { ProgressRing, Verdict, type VerdictTone } from './TaskHero.tsx'
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
  readonly remoteError: ShownError | null
  /** 重试清理临时文件；本端不能重试时为 null。 */
  readonly onRetryCleanup: (() => void) | null
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
  const receiver = local.role === 'receiver' ? local : remote?.role === 'receiver' ? remote : null
  const states = remote ? [local, remote] : [local]
  const result = receiver?.result ?? null
  const outcomes = result?.outcomes ?? []
  const succeeded = outcomes.filter((item) => item.status === 'succeeded')
  const unsettled = unsettledOutcomes(outcomes)
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
    hero = (
      <>
        <ProgressRing percent={percent} label={t(`task.stage.${leading.stage}`)} />
        {files.totalFiles > 0 && (
          <p>
            {t('task.files', { done: files.publishedFiles, total: files.totalFiles })} ·{' '}
            {formatBytes(files.fileBytesPublished)} / {formatBytes(files.totalFileBytes)}
          </p>
        )}
      </>
    )
  } else {
    const verdicts: Readonly<
      Record<Exclude<Phase, 'running'>, { tone: VerdictTone; title: string }>
    > = {
      done: { tone: 'ok', title: t('task.done') },
      partial: { tone: 'warn', title: t('task.partial') },
      failed: { tone: 'bad', title: t('task.failed') },
      cancelled: { tone: 'muted', title: t('task.cancelled') },
      unknown: { tone: 'warn', title: t('task.unknown') },
    }
    const verdict = verdicts[phase]
    let detail: ReactNode = null
    if (phase === 'done') {
      const written = t('task.doneDetail', { count: succeeded.length })
      detail = result?.backupId ? `${written} · ${t('task.backedUp')}` : written
    } else if (phase === 'partial') {
      detail = t('task.partialDetail', { ok: succeeded.length, failed: unsettled.length })
    } else if (phase === 'failed') {
      detail = error && <ErrorText error={error} context={null} />
    } else if (phase === 'unknown') {
      detail = t('task.unknownDetail')
    }
    hero = <Verdict tone={verdict.tone} title={verdict.title} detail={detail} />
  }
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
      <OutcomeList
        outcomes={outcomes}
        cleanupError={cleanupError}
        remoteError={remoteError}
        onRetryCleanup={onRetryCleanup}
      />
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
