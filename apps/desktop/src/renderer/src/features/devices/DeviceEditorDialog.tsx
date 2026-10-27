import { Button, Input, Modal, Space } from 'antd'

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
  return (
    <Modal
      title="管理设备"
      open={isOpen}
      confirmLoading={isBusy}
      okText="保存"
      onCancel={onCancel}
      onOk={onSave}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          {editingDeviceId && (
            <Button danger disabled={isBusy || isActive} onClick={onRemove}>
              移除设备
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
            设备名称
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
