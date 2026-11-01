import { useState } from 'react'
import { Dropdown } from 'antd'
import { List } from 'antd-mobile'
import { SwapOutlined } from '@ant-design/icons'

/** 选择行的一个选项。 */
export interface ChoiceOption<Value extends string> {
  readonly value: Value
  readonly label: string
}

/**
 * 设置列表里的选择行：右侧显示当前项，点整行从右侧弹出菜单，当前项高亮。
 * 按下时整行变色，菜单打开期间保持这个颜色。
 */
export function ChoiceItem<Value extends string>({
  title,
  options,
  value,
  isDisabled = false,
  onChange,
}: {
  readonly title: string
  readonly options: readonly ChoiceOption<Value>[]
  readonly value: Value
  readonly isDisabled?: boolean
  readonly onChange: (value: Value) => void
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      disabled={isDisabled}
      open={isOpen}
      onOpenChange={setIsOpen}
      menu={{
        selectable: true,
        selectedKeys: [value],
        items: options.map((item) => ({ key: item.value, label: item.label })),
        onClick: ({ key }) => {
          setIsOpen(false)
          const picked = options.find((item) => item.value === key)
          if (picked && picked.value !== value) {
            onChange(picked.value)
          }
        },
      }}
    >
      <List.Item
        clickable
        className={isOpen ? 'is-held' : ''}
        disabled={isDisabled}
        extra={options.find((item) => item.value === value)?.label}
        arrowIcon={<SwapOutlined rotate={90} />}
      >
        {title}
      </List.Item>
    </Dropdown>
  )
}
