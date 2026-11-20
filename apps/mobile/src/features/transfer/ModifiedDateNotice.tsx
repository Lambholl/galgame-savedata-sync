import { toShownError } from '@savedata-sync/shared'
import type { SyncPlan } from '@savedata-sync/shared'
import { WarningNotice, useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message'
import { useAllFilesAccess } from '../../app/use-all-files-access'

/**
 * 本机作为目标时的警告条：没有所有文件访问权限时，计划里要写入的文件设不了修改日期，下次比较仍显示内容不同。
 * 右侧是开启权限的按钮。有权限、计划没有文件写入、权限状态读不到或不在 Android 上时不显示。
 */
export function ModifiedDateNotice({
  plan,
}: {
  /** 本机作为目标的计划。 */
  readonly plan: SyncPlan
}): React.JSX.Element {
  const t = useT()
  const [showFailure, failureHolder] = useFailureMessage()
  const access = useAllFilesAccess()
  const isShown = access.isGranted === false && plan.transferFileCount > 0
  return (
    <>
      {failureHolder}
      {isShown ? (
        <div className="date-notice">
          <WarningNotice
            text={t('transfer.dateNotice', { count: plan.transferFileCount })}
            actionLabel={t('transfer.dateNoticeAction')}
            isActionDisabled={access.isOpening}
            onAction={() => {
              access
                .openSettings()
                .catch((cause: unknown) =>
                  showFailure(toShownError(cause), t('directAccess.openFailed')),
                )
            }}
          />
        </div>
      ) : null}
    </>
  )
}
