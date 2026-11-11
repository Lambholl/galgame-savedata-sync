import type { ReactElement } from 'react'
import { Button, Progress } from 'antd'
import {
  CheckOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  RightOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import type { TaskPreview } from '../task/task-presentation.ts'
import { SYNC_TASK_STEPS } from '../task/task-presentation.ts'
import { useT } from '../i18n/i18n-context.ts'
import './games.css'

/** 根页面的一条传输或恢复摘要。 */
export interface TaskStripInfo extends TaskPreview {
  /** 任务所属的游戏名，或没有关联游戏的批量传输任务的标题。 */
  readonly gameName: string
}

/** TaskStrip 的参数。 */
export interface TaskStripProps {
  /** 当前任务的短摘要。 */
  readonly task: TaskStripInfo
  /** 点按这条摘要。 */
  readonly onOpen: () => void
}

/** 任务摘要条：进行中显示阶段和进度，结束后显示结果；整条可以点按。 */
export function TaskStrip({ task, onOpen }: TaskStripProps): ReactElement {
  const isRunning = task.phase === 'running'
  const t = useT()
  const step = task.steps?.current ?? null
  const completed = step === null ? 0 : Math.min(step, SYNC_TASK_STEPS.length)
  const hasCurrent =
    step !== null &&
    step < SYNC_TASK_STEPS.length &&
    (isRunning || task.phase === 'failed' || task.phase === 'partial')
  const hasError = task.phase === 'failed' || task.phase === 'partial'
  const activeCount = completed + (hasCurrent ? 1 : 0)
  const currentPercent = task.percent ?? (hasError ? 100 : 0)
  const currentColor = hasError ? 'var(--ss-danger)' : 'var(--ss-accent)'
  // Progress 的 steps 只能整段着色，当前段按本阶段的计数另外画局部填充。
  const progressRootStyle = {
    display: 'flex',
    lineHeight: 0,
    '--ss-task-stage-fill': `linear-gradient(to right, ${currentColor} ${currentPercent}%, var(--ss-raised) ${currentPercent}%)`,
  }
  const colors = SYNC_TASK_STEPS.map((_, index) =>
    index < completed ? 'var(--ss-ok)' : hasError ? 'var(--ss-danger)' : 'var(--ss-accent)',
  )
  const statusText = `${task.status}${isRunning && task.percent !== null ? ` · ${task.percent}%` : ''}`
  return (
    <div
      className={`ss-task-strip is-${task.phase}`}
      data-current-step={hasCurrent ? step : undefined}
    >
      <span className="ss-task-strip-icon">
        {isRunning ? (
          task.percent === null ? (
            <LoadingOutlined spin />
          ) : (
            <SwapOutlined />
          )
        ) : task.phase === 'done' ? (
          <CheckOutlined />
        ) : (
          <ExclamationCircleOutlined />
        )}
      </span>
      <div className="ss-task-strip-body">
        <Button type="text" className="ss-task-strip-link" onClick={onOpen}>
          <b title={task.gameName}>{task.gameName}</b>
          <span>{statusText}</span>
        </Button>
        {task.steps && (
          <Progress
            className="ss-task-strip-progress"
            steps={SYNC_TASK_STEPS.length}
            percent={(activeCount / SYNC_TASK_STEPS.length) * 100}
            rounding={Math.floor}
            showInfo={false}
            size={[14, 4]}
            strokeColor={colors}
            railColor="var(--ss-raised)"
            classNames={{ track: 'ss-task-strip-segment' }}
            styles={{
              root: progressRootStyle,
              body: { width: '100%' },
              track: { flex: 1, width: 0 },
            }}
            aria-label={SYNC_TASK_STEPS.map((key) => t(key)).join(' / ')}
            aria-valuemax={SYNC_TASK_STEPS.length}
            aria-valuenow={completed + (hasCurrent ? currentPercent / 100 : 0)}
            aria-valuetext={statusText}
          />
        )}
      </div>
      <RightOutlined className="ss-task-strip-chevron" />
    </div>
  )
}
