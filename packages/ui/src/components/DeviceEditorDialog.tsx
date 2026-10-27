import { Button, Input, Modal, Space } from 'antd'

export function DeviceEditorDialog({
  isOpen,
  editingDeviceId,
  deviceName,
  deviceAddress,
  isMobile,
  isBusy,
  isActive,
  onDeviceNameChange,
  onDeviceAddressChange,
  onCancel,
  onSave,
  onRemove,
}: {
  readonly isOpen: boolean
  readonly editingDeviceId: string | null
  readonly deviceName: string
  readonly deviceAddress: string
  readonly isMobile: boolean
  readonly isBusy: boolean
  readonly isActive: boolean
  readonly onDeviceNameChange: (value: string) => void
  readonly onDeviceAddressChange: (value: string) => void
  readonly onCancel: () => void
  readonly onSave: () => void
  readonly onRemove: () => void
}): React.JSX.Element {
  return (
    <Modal
      title={editingDeviceId ? '管理设备' : '添加电脑'}
      open={isOpen}
      confirmLoading={isBusy}
      okText={editingDeviceId ? '保存' : '连接'}
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
        {isMobile && (
          <label className="library-field">
            电脑 HTTP 地址
            <Input
              placeholder="http://192.168.1.100:端口"
              value={deviceAddress}
              onChange={(event) => onDeviceAddressChange(event.target.value)}
            />
          </label>
        )}
      </Space>
    </Modal>
  )
}
