import { Modal } from 'antd'
import { useT } from '@savedata-sync/shared/ui'
import type { Confirmation } from '../app/navigation.ts'

export function ConfirmationDialog({
  confirmation,
  isBusy,
  onCancel,
  onConfirm,
}: {
  readonly confirmation: Confirmation | null
  readonly isBusy: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal
      title={confirmation?.title}
      open={Boolean(confirmation)}
      confirmLoading={isBusy}
      okText={t('common.confirm')}
      okType={confirmation?.okType ?? 'primary'}
      cancelText={t('common.cancel')}
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <p>{confirmation?.text}</p>
    </Modal>
  )
}
