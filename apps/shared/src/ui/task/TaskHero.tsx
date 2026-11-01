import type { ReactElement, ReactNode } from 'react'
import { Progress } from 'antd'
import {
  CheckOutlined,
  CloseOutlined,
  ExclamationOutlined,
  LoadingOutlined,
  MinusOutlined,
} from '@ant-design/icons'
import './sync-task-summary.css'

/** ProgressRing 的参数。 */
export interface ProgressRingProps {
  /** 当前阶段完成百分比，范围 0–100；无计数时为 null，显示加载标记。 */
  readonly percent: number | null
  /** 进度环中央显示的当前阶段。 */
  readonly label: string
}

/** 传输与恢复进行中的进度环。 */
export function ProgressRing({ percent, label }: ProgressRingProps): ReactElement {
  return (
    <Progress
      type="circle"
      aria-label={label}
      size={150}
      percent={percent ?? 0}
      aria-busy={percent === null}
      aria-valuetext={percent === null ? label : `${percent}%`}
      strokeColor="var(--ss-accent)"
      railColor="var(--ss-group)"
      format={() => (
        <span className="ss-ring-label">
          {percent === null ? <LoadingOutlined spin /> : <b>{percent}%</b>}
          <span>{label}</span>
        </span>
      )}
    />
  )
}

/** 结论的语气：ok 成功，warn 部分完成或待确认，bad 失败，muted 已取消。 */
export type VerdictTone = 'ok' | 'warn' | 'bad' | 'muted'

const VERDICT_ICON: Readonly<Record<VerdictTone, ReactElement>> = {
  ok: <CheckOutlined />,
  warn: <ExclamationOutlined />,
  bad: <CloseOutlined />,
  muted: <MinusOutlined />,
}

/** Verdict 的参数。 */
export interface VerdictProps {
  /** 结果语气，决定图标和颜色。 */
  readonly tone: VerdictTone
  /** 任务结果的本地化标题。 */
  readonly title: string
  /** 一行说明，可以是文字或 ErrorText；没有时为 null。 */
  readonly detail: ReactNode
}

/** 任务结束后的结论：图标、标题和一行说明。 */
export function Verdict({ tone, title, detail }: VerdictProps): ReactElement {
  return (
    <>
      <div className={`ss-verdict is-${tone}`}>{VERDICT_ICON[tone]}</div>
      <h2>{title}</h2>
      {detail && <div className="ss-verdict-detail">{detail}</div>}
    </>
  )
}
