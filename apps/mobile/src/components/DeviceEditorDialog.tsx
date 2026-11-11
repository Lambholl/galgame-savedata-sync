import { Button, Input } from 'antd-mobile'
import { useT } from '@savedata-sync/shared/ui'
import { Sheet } from './Sheet'

/** 编辑已保存设备的弹层：修改名称和地址，或移除设备。 */
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
  const t = useT()
  return (
    <Sheet
      isOpen={isOpen}
      title={t(editingDeviceId ? 'device.manage' : 'device.addPc')}
      isBusy={isBusy}
      layer={1100}
      onClose={onCancel}
    >
      <div className="page-stack">
        {editingDeviceId && (
          <label className="field">
            {t('device.name')}
            <Input
              value={deviceName}
              maxLength={128}
              disabled={isBusy}
              onChange={onDeviceNameChange}
            />
          </label>
        )}
        <label className="field">
          {t('device.address')}
          <Input
            placeholder={t('device.addressPlaceholder')}
            value={deviceAddress}
            inputMode="url"
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
          {t(editingDeviceId ? 'common.save' : 'device.connect')}
        </Button>
        {editingDeviceId && (
          <Button
            block
            color="danger"
            fill="outline"
            disabled={isBusy || isActive}
            onClick={onRemove}
          >
            {t('device.removeTitle')}
          </Button>
        )}
        <Button block disabled={isBusy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </Sheet>
  )
}
