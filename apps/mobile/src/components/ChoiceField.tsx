import { Radio } from 'antd-mobile'

export interface ChoiceOption {
  readonly value: string
  readonly label: string
  readonly isDisabled?: boolean
}

/** 选项直接显示，整行触控；避免窄屏使用桌面下拉菜单。 */
export function ChoiceField({
  label,
  value,
  options,
  isDisabled = false,
  onChange,
}: {
  readonly label: string
  readonly value: string
  readonly options: readonly ChoiceOption[]
  readonly isDisabled?: boolean
  readonly onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <fieldset className="choice-field" disabled={isDisabled}>
      <legend>{label}</legend>
      {options.length ? (
        options.map((option) => (
          <Radio
            key={option.value}
            className="choice-row"
            block
            value={option.value}
            checked={value === option.value}
            disabled={isDisabled || Boolean(option.isDisabled)}
            onChange={(isChecked) => {
              if (isChecked) {
                onChange(option.value)
              }
            }}
          >
            {option.label}
          </Radio>
        ))
      ) : (
        <p className="muted">暂无可选项</p>
      )}
    </fieldset>
  )
}
