import { Button, Input, Space } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { formatConnectionAddress } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'

export function AddressField({
  address,
  copied,
  onCopy,
}: {
  readonly address: string
  readonly copied: string
  readonly onCopy: (address: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <Space.Compact block className="library-compact">
      <Input readOnly aria-label={t('device.address')} value={formatConnectionAddress(address)} />
      <Button
        icon={copied === address ? <CheckOutlined /> : <CopyOutlined />}
        aria-label={t('device.copyAddress')}
        onClick={() => onCopy(address)}
      />
    </Space.Compact>
  )
}
