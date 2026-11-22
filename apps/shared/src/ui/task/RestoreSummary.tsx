import type { ReactElement, ReactNode } from 'react'
import { ArrowRightOutlined, HistoryOutlined, RightOutlined } from '@ant-design/icons'
import type { ShownError } from '../../result.ts'
import type {
  SyncApplyResult,
  SyncRestoreFailureStage,
  SyncRestoreProgress,
  SyncRestoreStage,
  SyncRestoreStatus,
} from '../../sync/sync-contracts.ts'
import { observeRestoreTask } from '../../sync/sync-restore-observation.ts'
import type { SyncTaskPhase } from '../../sync/sync-job-observation.ts'
import { formatBytes, formatDateTime } from '../../i18n/format.ts'
import { ErrorText } from '../errors/ErrorText.tsx'
import { errorDetail } from '../errors/error-detail.ts'
import type { PlanEndpoint } from '../plan/SyncPlanSummary.tsx'
import { useLocale, useT } from '../i18n/i18n-context.ts'
import { OutcomeList } from './OutcomeList.tsx'
import { countOutcomes, unsettledOutcomes } from './outcomes.ts'
import { ProgressRing, Verdict, type VerdictTone } from './TaskHero.tsx'
import { TaskSteps } from './TaskSteps.tsx'
import { RESTORE_TASK_STEPS } from './task-presentation.ts'
import './sync-task-summary.css'

/** RestoreSummary 的参数。 */
export interface RestoreSummaryProps {
  /** 本次恢复的游戏名。 */
  readonly gameName: string
  /** 备份来源一端。 */
  readonly source: PlanEndpoint
  /** 被写入的本机目标一端。 */
  readonly target: PlanEndpoint
  /** 恢复任务编号，用于技术详情。 */
  readonly restoreId: string
  /** 恢复任务状态。 */
  readonly status: SyncRestoreStatus
  /** 恢复任务当前阶段。 */
  readonly stage: SyncRestoreStage
  /** 任务失败或中断时所在的阶段；没有记录时为 null。 */
  readonly failureStage: SyncRestoreFailureStage | null
  /** 最近一次状态更新的 Unix 毫秒时间戳。 */
  readonly updatedAt: number
  /** 恢复任务在备份与写入阶段的字节和文件计数。 */
  readonly progress: SyncRestoreProgress
  /** 本机回读得到的写入结果；还没有结果时为 null。 */
  readonly result: SyncApplyResult | null
  /** 任务失败的原因；没有失败时为 null。 */
  readonly error: ShownError | null
  /** 清理临时文件失败的原因；没有失败时为 null。 */
  readonly cleanupError: ShownError | null
  /** 重试清理临时文件；不能重试时为 null。 */
  readonly onRetryCleanup: (() => void) | null
  /** 点按“查看备份”，只在恢复结束后显示在技术详情上方；为 null 时不显示这一行。 */
  readonly onViewBackup: (() => void) | null
  /** 渲染技术详情卡片。 */
  readonly renderTechnicalDetails: (text: string) => ReactNode
}

/**
 * 恢复详情：与传输详情使用同一套布局，先给路线和结论（进行中显示进度环，结束后显示最终结果），
 * 再给两步阶段条（备份、写入）、需要处理和已写入的文件，以及折叠的技术详情。
 */
export function RestoreSummary({
  gameName,
  source,
  target,
  restoreId,
  status,
  stage,
  failureStage,
  updatedAt,
  progress,
  result,
  error,
  cleanupError,
  onRetryCleanup,
  onViewBackup,
  renderTechnicalDetails,
}: RestoreSummaryProps): ReactElement {
  const t = useT()
  const locale = useLocale()
  const outcomes = result?.outcomes ?? []
  const unsettled = unsettledOutcomes(outcomes)
  const counts = countOutcomes(outcomes)
  const observation = observeRestoreTask({
    status,
    stage,
    failureStage,
    progress,
    result,
    cleanupError,
  })
  const { phase, step, percent, counters } = observation
  const effectiveError = result?.error ?? error
  const effectiveCleanupError = result?.cleanupError ?? cleanupError
  const technicalText = [
    `${t('task.techTask')} ${restoreId}`,
    `${t('task.techLocal')} restore/${status}/${stage}`,
    `${t('task.techUpdated')} ${formatDateTime(updatedAt, locale)}`,
    ...(effectiveError ? [`${t('task.techError')} ${errorDetail(effectiveError)}`] : []),
    ...(effectiveCleanupError
      ? [`${t('task.cleanupFailed')} ${errorDetail(effectiveCleanupError)}`]
      : []),
    ...unsettled.flatMap((item) =>
      item.error ? [`${item.path.join('/')} ${errorDetail(item.error)}`] : [],
    ),
  ].join('\n')

  let hero: ReactElement
  if (phase === 'running') {
    const stageKey = (
      observation.stage === 'ready' ? 'task.stage.preparing' : `task.stage.${observation.stage}`
    ) as `task.stage.${typeof observation.stage}`
    const hasBytes = counters.totalBytes !== null && counters.totalBytes > 0
    const shouldShowCounters = percent !== null && (step === 0 ? hasBytes : counters.totalFiles > 0)
    hero = (
      <>
        <ProgressRing percent={percent} label={t(stageKey)} />
        {shouldShowCounters ? (
          <p>
            {counters.completedFiles !== null ? (
              <>
                {t('task.files', { done: counters.completedFiles, total: counters.totalFiles })}{' '}
                ·{' '}
              </>
            ) : null}
            {formatBytes(counters.completedBytes)} /{' '}
            {counters.totalBytes === null ? '—' : formatBytes(counters.totalBytes)}
          </p>
        ) : null}
      </>
    )
  } else {
    const verdicts: Readonly<
      Record<Exclude<SyncTaskPhase, 'running'>, { tone: VerdictTone; title: string }>
    > = {
      done: { tone: 'ok', title: t('backup.restored') },
      partial: { tone: 'warn', title: t('task.partial') },
      failed: { tone: 'bad', title: t('backup.restoreFailed') },
      cancelled: { tone: 'muted', title: t('backup.restoreCancelled') },
      unknown: { tone: 'warn', title: t('backup.restoreUnknown') },
    }
    const verdict = verdicts[phase]
    let detail: ReactNode = null
    const { files, folders, deleted } = counts
    if (phase === 'done') {
      const backedUp =
        typeof result?.backupFileCount === 'number'
          ? t('task.backedUpCount', { count: result.backupFileCount })
          : t('task.backedUp')
      detail = [
        ...(files > 0 || (folders === 0 && deleted === 0)
          ? [t('backup.restoredDetail', { count: files })]
          : []),
        ...(folders > 0 ? [t('task.foldersCreatedDetail', { count: folders })] : []),
        ...(deleted > 0 ? [t('task.deletedDetail', { count: deleted })] : []),
        ...(result?.backupId ? [backedUp] : []),
      ].join(' · ')
    } else if (phase === 'partial' || (phase === 'unknown' && counts.succeeded > 0)) {
      detail = t('task.partialDetail', counts)
    } else if (phase === 'failed') {
      detail = effectiveError ? <ErrorText error={effectiveError} context={null} /> : null
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
      <TaskSteps step={step} phase={phase} percent={percent} steps={RESTORE_TASK_STEPS} />
      <OutcomeList
        outcomes={outcomes}
        cleanupError={effectiveCleanupError}
        remoteError={null}
        onRetryCleanup={onRetryCleanup}
      />
      {/* 整行可点的入口，与技术详情同一形式；不用文字链接。 */}
      {phase !== 'running' && onViewBackup ? (
        <div className="ss-task-group">
          <button type="button" className="ss-task-row ss-pressable" onClick={onViewBackup}>
            <span className="ss-task-lead is-accent">
              <HistoryOutlined />
            </span>
            <span className="ss-task-body">{t('task.viewBackup')}</span>
            <RightOutlined className="ss-task-chevron" />
          </button>
        </div>
      ) : null}
      {renderTechnicalDetails(technicalText)}
    </div>
  )
}
