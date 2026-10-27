import { Button, Input, Space } from 'antd'
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'

export function AddressField({
  address,
  copied,
  onCopy,
}: {
  readonly address: string
  readonly copied: string
  readonly onCopy: (address: string) => void
}): React.JSX.Element {
  return (
    <Space.Compact block className="library-compact">
      <Input readOnly aria-label="HTTP 地址" value={address} />
      <Button
        icon={copied === address ? <CheckOutlined /> : <CopyOutlined />}
        aria-label="复制地址"
        onClick={() => onCopy(address)}
      />
    </Space.Compact>
  )
}
