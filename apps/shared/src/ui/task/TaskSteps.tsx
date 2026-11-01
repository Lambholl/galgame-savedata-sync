import type { ReactElement } from 'react'
import { Steps } from 'antd'
import type { SyncTaskPhase } from './task-presentation.ts'
import { SYNC_TASK_STEPS } from './task-presentation.ts'
import { useT } from '../i18n/i18n-context.ts'
import './sync-task-summary.css'

/** TaskSteps 的参数。 */
export interface TaskStepsProps {
  /** 五阶段的当前索引，5 表示全部完成，null 表示阶段未记录。 */
  readonly step: number | null
  /** 任务状态；失败和部分完成标记当前阶段出错。 */
  readonly phase: SyncTaskPhase
  /** 当前步骤的完成百分比；没有计数时使用起始刻度。 */
  readonly percent: number | null
}

/** 双端共用的只读阶段条；实际阶段由任务状态提供。 */
export function TaskSteps({ step, phase, percent }: TaskStepsProps): ReactElement {
  const t = useT()
  const hasError = phase === 'failed' || phase === 'partial'
  return (
    <div className="ss-task-steps">
      <Steps
        type="default"
        titlePlacement="vertical"
        size="small"
        responsive={false}
        current={step === null ? -1 : Math.min(step, SYNC_TASK_STEPS.length)}
        percent={percent ?? 0}
        status={
          hasError && step !== null
            ? 'error'
            : phase === 'done'
              ? 'finish'
              : phase === 'running'
                ? 'process'
                : 'wait'
        }
        aria-label={SYNC_TASK_STEPS.map((key) => t(key)).join(' / ')}
        items={SYNC_TASK_STEPS.map((key) => ({ title: t(key) }))}
      />
      {hasError && step === null && (
        <p className="ss-task-stage-missing">{t('task.failureStageMissing')}</p>
      )}
    </div>
  )
}
