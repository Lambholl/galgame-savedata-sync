import type { ReactElement } from 'react'
import { LoadingOutlined } from '@ant-design/icons'
import type { ShownError } from '../../result.ts'
import type { SyncApplyResult } from '../../sync/sync-contracts.ts'
import { ErrorText } from '../errors/ErrorText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import { OutcomeList } from './OutcomeList.tsx'
import { unsettledOutcomes } from './outcomes.ts'
import { ProgressRing, Verdict } from './TaskHero.tsx'
import './sync-task-summary.css'

/** 恢复任务在确认之后所处的阶段。 */
export type RestorePhase =
  'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** RestoreSummary 的参数。 */
export interface RestoreSummaryProps {
  /** 恢复任务所处阶段。 */
  readonly phase: RestorePhase
  /** 已写入和总文件数；没有进度时为 null。 */
  readonly progress: { readonly done: number; readonly total: number } | null
  /** 本机回读得到的写入结果；还没有结果时为 null。 */
  readonly result: SyncApplyResult | null
  /** 任务失败的原因；没有失败时为 null。 */
  readonly error: ShownError | null
  /** 清理临时文件失败的原因；没有失败时为 null。 */
  readonly cleanupError: ShownError | null
  /** 重试清理临时文件；不能重试时为 null。 */
  readonly onRetryCleanup: (() => void) | null
}

/** 恢复进度和结果：进行中显示进度环，结束后先给结论，再列需要处理和已恢复的文件。 */
export function RestoreSummary({
  phase,
  progress,
  result,
  error,
  cleanupError,
  onRetryCleanup,
}: RestoreSummaryProps): ReactElement {
  const t = useT()
  const outcomes = result?.outcomes ?? []
  const unsettled = unsettledOutcomes(outcomes)
  const ok = outcomes.length - unsettled.length
  let hero: ReactElement
  if (phase === 'preparing') {
    hero = (
      <p className="ss-task-wait">
        <LoadingOutlined /> {t('backup.preparing')}
      </p>
    )
  } else if (phase === 'running' && !progress) {
    hero = (
      <p className="ss-task-wait">
        <LoadingOutlined /> {t('task.stage.writing')}
      </p>
    )
  } else if (phase === 'running' && progress) {
    hero = (
      <ProgressRing
        percent={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
        label={t('backup.restoring', progress)}
      />
    )
  } else if (phase === 'succeeded' && !result?.error && unsettled.length === 0) {
    hero = (
      <Verdict
        tone="ok"
        title={t('backup.restored')}
        detail={t('backup.restoredDetail', { count: ok })}
      />
    )
  } else if (result && ok > 0) {
    hero = (
      <Verdict
        tone="warn"
        title={t('task.partial')}
        detail={t('task.partialDetail', { ok, failed: unsettled.length })}
      />
    )
  } else if (phase === 'cancelled') {
    hero = <Verdict tone="muted" title={t('backup.restoreCancelled')} detail={null} />
  } else if (phase === 'unknown') {
    hero = (
      <Verdict tone="warn" title={t('backup.restoreUnknown')} detail={t('task.unknownDetail')} />
    )
  } else {
    const reason = result?.error ?? error
    hero = (
      <Verdict
        tone="bad"
        title={t('backup.restoreFailed')}
        detail={reason && <ErrorText error={reason} context={null} />}
      />
    )
  }
  return (
    <div className="ss-task">
      <div className="ss-task-hero">{hero}</div>
      <OutcomeList
        outcomes={outcomes}
        cleanupError={result?.cleanupError ?? cleanupError}
        remoteError={null}
        onRetryCleanup={onRetryCleanup}
      />
    </div>
  )
}
