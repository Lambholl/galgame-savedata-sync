import { Button, Input, Modal, Space } from 'antd'
import { useT } from '@savedata-sync/shared/ui'

export function DeviceEditorDialog({
  isOpen,
  editingDeviceId,
  deviceName,
  isBusy,
  isActive,
  onDeviceNameChange,
  onCancel,
  onSave,
  onRemove,
}: {
  readonly isOpen: boolean
  readonly editingDeviceId: string | null
  readonly deviceName: string
  readonly isBusy: boolean
  readonly isActive: boolean
  readonly onDeviceNameChange: (value: string) => void
  readonly onCancel: () => void
  readonly onSave: () => void
  readonly onRemove: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Modal
      title={t('device.manage')}
      open={isOpen}
      confirmLoading={isBusy}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onCancel={onCancel}
      onOk={onSave}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          {editingDeviceId && (
            <Button danger disabled={isBusy || isActive} onClick={onRemove}>
              {t('device.removeTitle')}
            </Button>
          )}
          <OkBtn />
          <CancelBtn />
        </>
      )}
    >
      <Space orientation="vertical" className="library-full">
        {editingDeviceId && (
          <label className="library-field">
            {t('device.name')}
            <Input
              value={deviceName}
              maxLength={128}
              onChange={(event) => onDeviceNameChange(event.target.value)}
            />
          </label>
        )}
      </Space>
    </Modal>
  )
}
