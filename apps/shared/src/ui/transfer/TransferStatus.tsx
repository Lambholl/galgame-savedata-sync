import type { ReactElement } from 'react'
import { LoadingOutlined } from '@ant-design/icons'
import { useT } from '../i18n/i18n-context.ts'
import type { ComparisonStatus } from './TransferComparison.tsx'
import './transfer-status.css'

interface TransferStatusProps {
  /** 与 TransferComparison 相同的比较进度，失败和无法比较除外。 */
  readonly status: Exclude<ComparisonStatus, { readonly kind: 'failed' | 'unavailable' }>
}

/** 比较完成前摘要行的说明：等待和扫描中都写“正在比较两端”，取消后写已取消。 */
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
    case 'cancelled':
      return (
        <span className="ss-transfer-status" role="status">
          <span>{t('transfer.compareCancelled')}</span>
        </span>
      )
  }
}
