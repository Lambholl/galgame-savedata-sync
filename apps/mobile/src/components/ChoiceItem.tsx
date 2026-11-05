import { useEffect, useState } from 'react'
import { Dropdown } from 'antd'
import { List } from 'antd-mobile'
import { DownOutlined } from '@ant-design/icons'
import { ChoiceLabel } from '@savedata-sync/shared/ui'

/** 选择行的一个选项。 */
export interface ChoiceOption<Value extends string> {
  readonly value: Value
  readonly label: string
}

/**
 * 设置列表里的选择行：右侧显示当前项，点整行从右侧弹出菜单，当前项高亮。
 * 按下时整行变色，菜单打开期间保持这个颜色。
 * 菜单打开时通过 onOverlayChange 登记关闭函数，Android 返回键先关菜单，再按才返回页面。
 */
export function ChoiceItem<Value extends string>({
  title,
  options,
  value,
  isDisabled = false,
  onChange,
  onOverlayChange,
}: {
  readonly title: string
  readonly options: readonly ChoiceOption<Value>[]
  readonly value: Value
  readonly isDisabled?: boolean
  readonly onChange: (value: Value) => void
  readonly onOverlayChange: (close: (() => void) | null) => void
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    if (!isOpen) {
      return
    }
    onOverlayChange(() => setIsOpen(false))
    return () => onOverlayChange(null)
  }, [isOpen, onOverlayChange])
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      classNames={{ root: 'settings-choice-popup' }}
      styles={{ root: { width: 'max-content', minWidth: 160, maxWidth: 'calc(100vw - 32px)' } }}
      disabled={isDisabled}
      open={isOpen}
      onOpenChange={setIsOpen}
      menu={{
        selectable: true,
        selectedKeys: [value],
        items: options.map((item) => ({
          key: item.value,
          label: <ChoiceLabel text={item.label} isSelected={item.value === value} />,
        })),
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
        extra={
          <span className="settings-choice-value">
            <span>{options.find((item) => item.value === value)?.label}</span>
            <DownOutlined />
          </span>
        }
        arrowIcon={false}
      >
        {title}
      </List.Item>
    </Dropdown>
  )
}
