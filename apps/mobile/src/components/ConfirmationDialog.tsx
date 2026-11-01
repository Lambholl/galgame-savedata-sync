import { Button } from 'antd-mobile'
import { useT } from '@savedata-sync/shared/ui'
import type { Confirmation } from '../app/navigation-types'
import { Sheet } from './Sheet'

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
    <Sheet
      isOpen={Boolean(confirmation)}
      title={confirmation?.title ?? ''}
      layer={1200}
      isBusy={isBusy}
      onClose={onCancel}
    >
      <p className="confirmation-text">{confirmation?.text}</p>
      <div className="action-row equal">
        <Button disabled={isBusy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          color={confirmation?.okType === 'danger' ? 'danger' : 'primary'}
          loading={isBusy}
          disabled={isBusy}
          onClick={onConfirm}
        >
          {t('common.confirm')}
        </Button>
      </div>
    </Sheet>
  )
}
