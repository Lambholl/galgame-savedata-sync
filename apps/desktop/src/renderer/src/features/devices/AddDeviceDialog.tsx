import { Input, Modal } from 'antd'
import { useT } from '@savedata-sync/shared/ui'

/** 手动输入另一台设备的 IP 和端口并连接的弹窗。 */
export function AddDeviceDialog({
  isOpen,
  address,
  isBusy,
  onAddressChange,
  onCancel,
  onConnect,
}: {
  readonly isOpen: boolean
  readonly address: string
  readonly isBusy: boolean
  readonly onAddressChange: (value: string) => void
  readonly onCancel: () => void
  /** 点“连接”或在输入框按回车时触发；地址为空时不触发。 */
  readonly onConnect: () => void
}): React.JSX.Element {
  const t = useT()
  const isEmpty = !address.trim()
  return (
    <Modal
      title={t('device.addPc')}
      open={isOpen}
      confirmLoading={isBusy}
      okText={t('device.connect')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: isEmpty }}
      destroyOnHidden
      onCancel={onCancel}
      onOk={onConnect}
    >
      <label className="library-field">
        {t('device.address')}
        <Input
          size="large"
          autoFocus
          value={address}
          placeholder={t('device.addressPlaceholder')}
          maxLength={64}
          onChange={(event) => onAddressChange(event.target.value)}
          onPressEnter={() => {
            if (!isEmpty && !isBusy) {
              onConnect()
            }
          }}
        />
      </label>
    </Modal>
  )
}
