import { Select } from 'antd'
import { ChoiceLabel } from '@savedata-sync/shared/ui'

/** 设置下拉框中的一个选项。 */
export interface SettingOption<Value extends string> {
  readonly value: Value
  readonly label: string
}

/** 设置行右侧的选择器：菜单右对齐，显示当前项的勾选。 */
export function SettingSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string
  readonly value: Value
  readonly options: readonly SettingOption<Value>[]
  readonly onChange: (value: Value) => void
}): React.JSX.Element {
  return (
    <Select<Value, SettingOption<Value>>
      aria-label={label}
      className="settings-select"
      classNames={{ popup: { root: 'settings-select-popup' } }}
      placement="bottomRight"
      popupMatchSelectWidth={false}
      value={value}
      options={[...options]}
      optionRender={(option) => (
        <ChoiceLabel text={option.data.label} isSelected={option.value === value} />
      )}
      onChange={onChange}
    />
  )
}
