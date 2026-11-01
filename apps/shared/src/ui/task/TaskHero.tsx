import type { ReactElement } from 'react'
import { CheckOutlined, CloseOutlined, ExclamationOutlined, MinusOutlined } from '@ant-design/icons'
import './sync-task-summary.css'

const RADIUS = 64
const CIRCLE = 2 * Math.PI * RADIUS

/** 传输与恢复进行中的进度环；percent 为 0–100。 */
export function ProgressRing({
  percent,
  label,
}: {
  readonly percent: number
  readonly label: string
}): ReactElement {
  return (
    <div className="ss-ring">
      <svg viewBox="0 0 150 150" aria-hidden="true">
        <circle className="is-track" cx="75" cy="75" r={RADIUS} />
        <circle
          className="is-fill"
          cx="75"
          cy="75"
          r={RADIUS}
          strokeDasharray={CIRCLE}
          strokeDashoffset={CIRCLE * (1 - percent / 100)}
        />
      </svg>
      <div>
        <b>{percent}%</b>
        <span>{label}</span>
      </div>
    </div>
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

/** 任务结束后的结论：图标、标题和一行说明。 */
export function Verdict({
  tone,
  title,
  detail,
}: {
  readonly tone: VerdictTone
  readonly title: string
  readonly detail: string | null
}): ReactElement {
  return (
    <>
      <div className={`ss-verdict is-${tone}`}>{VERDICT_ICON[tone]}</div>
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
    </>
  )
}
