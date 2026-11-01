import type { ReactNode } from 'react'
import { CaretRightOutlined } from '@ant-design/icons'
import type { SyncPlan } from '@savedata-sync/shared'
import { SyncPlanSummary } from '@savedata-sync/shared/ui'
import type { PlanEndpoint } from '@savedata-sync/shared/ui'
import { FloatingAction } from '../../components/FloatingAction'

/** 确认页右下角唯一的开始按钮。 */
export interface PlanConfirmAction {
  readonly label: string
  readonly isDisabled: boolean
  readonly isLoading: boolean
  readonly onClick: () => void
}

/**
 * 计划确认页：传输计划和恢复预览共用。提示写在计划上方，开始按钮悬浮在右下角。
 */
export function PlanConfirm({
  plan,
  source,
  target,
  backupKeepCount,
  notice,
  action,
}: {
  readonly plan: SyncPlan
  readonly source: PlanEndpoint
  readonly target: PlanEndpoint
  /** 目标端保留的备份份数；读不到时为 null。 */
  readonly backupKeepCount: number | null
  /** 计划上方的提示，例如计划已过期或目录已更换；没有时为 null。 */
  readonly notice: ReactNode
  readonly action: PlanConfirmAction
}): React.JSX.Element {
  return (
    <>
      {notice}
      <SyncPlanSummary
        key={plan.planId}
        plan={plan}
        source={source}
        target={target}
        backupKeepCount={backupKeepCount}
      />
      <FloatingAction
        color="primary"
        icon={<CaretRightOutlined />}
        iconPlacement="start"
        label={action.label}
        isDisabled={action.isDisabled}
        isLoading={action.isLoading}
        onClick={action.onClick}
      />
    </>
  )
}
