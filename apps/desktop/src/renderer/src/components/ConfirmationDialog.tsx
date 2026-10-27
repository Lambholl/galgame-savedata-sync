import { Modal } from 'antd'
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
  return (
    <Modal
      title={confirmation?.title}
      open={Boolean(confirmation)}
      confirmLoading={isBusy}
      okText="确认"
      okType={confirmation?.okType ?? 'primary'}
      cancelText="取消"
      onCancel={onCancel}
      onOk={onConfirm}
    >
      <p>{confirmation?.text}</p>
    </Modal>
  )
}
