import type { ReactElement, ReactNode } from 'react'
import { ArrowRightOutlined, HistoryOutlined, RightOutlined } from '@ant-design/icons'
import type { ShownError } from '../../result.ts'
import { ErrorText } from '../errors/ErrorText.tsx'
import { errorDetail } from '../errors/error-detail.ts'
import type { SyncJobState } from '../../sync/sync-job-contracts.ts'
import { formatBytes, formatDateTime } from '../../i18n/format.ts'
import type { PlanEndpoint } from '../plan/SyncPlanSummary.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import { OutcomeList } from './OutcomeList.tsx'
import { unsettledOutcomes } from './outcomes.ts'
import { ProgressRing, Verdict, type VerdictTone } from './TaskHero.tsx'
import { locateSyncError, observeSyncJob } from '../../sync/sync-job-observation.ts'
import type { SyncTaskPhase } from '../../sync/sync-job-observation.ts'
import { TaskSteps } from './TaskSteps.tsx'
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
  /**
   * 打开被写入一端的备份；本机不是被写入的一端（备份不在本机）时为 null。
   * 传输结束后显示为技术详情上方可点的一行，进行中不显示。
   */
  readonly onViewBackup: (() => void) | null
  /** 由平台包装的技术详情卡片，负责复制、长按和展开状态。 */
  readonly renderTechnicalDetails: (text: string) => ReactNode
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
  onViewBackup,
  renderTechnicalDetails,
}: SyncTaskSummaryProps): ReactElement {
  const t = useT()
  const locale = useLocale()
  const receiver = local.role === 'receiver' ? local : remote?.role === 'receiver' ? remote : null
  const states = remote ? [local, remote] : [local]
  const result = receiver?.result ?? null
  const outcomes = result?.outcomes ?? []
  const succeeded = outcomes.filter((item) => item.status === 'succeeded')
  const unsettled = unsettledOutcomes(outcomes)
  const { phase, stage, step, percent, counters, failureStage } = observeSyncJob(
    local,
    remote,
    remoteError !== null,
  )
  const error = result?.error ?? states.find((item) => item.error)?.error ?? null
  const cleanupError = result?.cleanupError ?? local.cleanupError ?? remote?.cleanupError ?? null
  const technicalText = [
    `${t('task.techTask')} ${local.jobId}`,
    `${t('task.techLocal')} ${local.role}/${local.status}/${local.stage}`,
    ...(remote ? [`${t('task.techRemote')} ${remote.role}/${remote.status}/${remote.stage}`] : []),
    `${t('task.techUpdated')} ${formatDateTime(local.updatedAt, locale)}`,
    // 界面只写本地化说明，原始消息与错误码都在这里。
    ...(error ? [`${t('task.techError')} ${errorDetail(error)}`] : []),
    ...(remoteError ? [`${t('task.remoteError')} ${errorDetail(remoteError)}`] : []),
    ...(cleanupError ? [`${t('task.cleanupFailed')} ${errorDetail(cleanupError)}`] : []),
    ...unsettled.flatMap((item) =>
      item.error ? [`${item.path.join('/')} ${errorDetail(item.error)}`] : [],
    ),
  ].join('\n')
  let hero: ReactElement
  if (phase === 'running') {
    hero = (
      <>
        <ProgressRing percent={percent} label={t(`task.stage.${stage}`)} />
        {percent !== null && counters.totalFiles > 0 && (
          <p>
            {counters.completedFiles !== null && (
              <>
                {t('task.files', { done: counters.completedFiles, total: counters.totalFiles })}{' '}
                ·{' '}
              </>
            )}
            {formatBytes(counters.completedBytes)} /{' '}
            {counters.totalBytes === null ? '—' : formatBytes(counters.totalBytes)}
          </p>
        )}
      </>
    )
  } else {
    const verdicts: Readonly<
      Record<Exclude<SyncTaskPhase, 'running'>, { tone: VerdictTone; title: string }>
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
      const deleted = succeeded.filter(
        (item) => item.action === 'delete-file' || item.action === 'delete-directory',
      ).length
      const written = succeeded.length - deleted
      // 数量读不到时仍说已备份，这是确知的。
      const backedUp =
        typeof result?.backupFileCount === 'number'
          ? t('task.backedUpCount', { count: result.backupFileCount })
          : t('task.backedUp')
      detail = [
        ...(written > 0 || deleted === 0 ? [t('task.doneDetail', { count: written })] : []),
        ...(deleted > 0 ? [t('task.deletedDetail', { count: deleted })] : []),
        ...(result?.backupId ? [backedUp] : []),
      ].join(' · ')
    } else if (phase === 'partial') {
      detail = t('task.partialDetail', { ok: succeeded.length, failed: unsettled.length })
    } else if (phase === 'failed') {
      detail = error && (
        <ErrorText error={locateSyncError(error, local.direction, failureStage)} context={null} />
      )
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
      <TaskSteps step={step} phase={phase} percent={percent} />
      <OutcomeList
        outcomes={outcomes}
        cleanupError={cleanupError}
        remoteError={remoteError}
        onRetryCleanup={onRetryCleanup}
      />
      {/* 整行可点的入口，与技术详情同一形式；不用文字链接。 */}
      {phase !== 'running' && onViewBackup && (
        <div className="ss-task-group">
          <button type="button" className="ss-task-row ss-pressable" onClick={onViewBackup}>
            <span className="ss-task-lead is-accent">
              <HistoryOutlined />
            </span>
            <span className="ss-task-body">{t('task.viewBackup')}</span>
            <RightOutlined className="ss-task-chevron" />
          </button>
        </div>
      )}
      {renderTechnicalDetails(technicalText)}
    </div>
  )
}
