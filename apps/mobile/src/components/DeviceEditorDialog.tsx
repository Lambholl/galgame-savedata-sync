import { Button, Input } from 'antd-mobile'
import { Sheet } from './Sheet'

export function DeviceEditorDialog({
  isOpen,
  editingDeviceId,
  deviceName,
  deviceAddress,
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
  readonly isBusy: boolean
  readonly isActive: boolean
  readonly onDeviceNameChange: (value: string) => void
  readonly onDeviceAddressChange: (value: string) => void
  readonly onCancel: () => void
  readonly onSave: () => void
  readonly onRemove: () => void
}): React.JSX.Element {
  return (
    <Sheet
      isOpen={isOpen}
      title={editingDeviceId ? '管理设备' : '添加电脑'}
      isBusy={isBusy}
      layer={1100}
      onClose={onCancel}
    >
      <div className="page-stack">
        {editingDeviceId && (
          <label className="field">
            设备名称
            <Input
              value={deviceName}
              maxLength={128}
              disabled={isBusy}
              onChange={onDeviceNameChange}
            />
          </label>
        )}
        <label className="field">
          电脑 HTTP 地址
          <Input
            placeholder="http://192.168.1.100:端口"
            value={deviceAddress}
            type="url"
            autoCapitalize="off"
            autoCorrect="off"
            disabled={isBusy}
            onChange={onDeviceAddressChange}
          />
        </label>
        <Button
          block
          color="primary"
          loading={isBusy}
          disabled={isBusy || (!editingDeviceId && isActive)}
          onClick={onSave}
        >
          {editingDeviceId ? '保存' : '连接'}
        </Button>
        {editingDeviceId && (
          <Button
            block
            color="danger"
            fill="outline"
            disabled={isBusy || isActive}
            onClick={onRemove}
          >
            移除设备
          </Button>
        )}
        <Button block disabled={isBusy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </Sheet>
  )
}
