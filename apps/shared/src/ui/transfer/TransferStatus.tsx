import type { ReactElement } from 'react'
import { LoadingOutlined } from '@ant-design/icons'
import { ErrorText } from '../errors/ErrorText.tsx'
import { useT } from '../i18n/i18n-context.ts'
import type { ComparisonStatus } from './TransferComparison.tsx'
import './transfer-status.css'

interface TransferStatusProps {
  /** 与 TransferComparison 相同的比较进度。 */
  readonly status: ComparisonStatus
}

/** 比较完成前摘要行的说明：等待和扫描中都写“正在比较两端”，另有取消、失败和无法比较的原因。 */
export function TransferStatus({ status }: TransferStatusProps): ReactElement {
  const t = useT()
  switch (status.kind) {
    case 'waiting':
    case 'scanning':
      return (
        <span className="ss-transfer-status" role="status">
          <LoadingOutlined />
          <span>{t('transfer.comparing')}</span>
        </span>
      )
    case 'ready':
      return <span className="ss-transfer-status" role="status" />
    case 'failed':
      return (
        <span className="ss-transfer-status is-error" role="alert">
          {status.error ? (
            <ErrorText error={status.error} context={t('transfer.compareFailedContext')} />
          ) : (
            <span>{t('transfer.compareFailed')}</span>
          )}
        </span>
      )
    case 'cancelled':
      return (
        <span className="ss-transfer-status" role="status">
          <span>{t('transfer.compareCancelled')}</span>
        </span>
      )
    case 'unavailable':
      return (
        <span className="ss-transfer-status" role="status">
          <span>{status.reason}</span>
        </span>
      )
  }
}
