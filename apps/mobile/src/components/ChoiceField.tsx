import { Radio } from 'antd-mobile'
import { useT } from '@savedata-sync/shared/ui'

/** 单选列表中的一个选项。 */
export interface ChoiceOption {
  readonly value: string
  readonly label: string
  readonly isDisabled?: boolean
}

/** 单选列表：选项直接显示，点整行选择。 */
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
  const t = useT()
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
        <p className="muted">{t('common.noOptions')}</p>
      )}
    </fieldset>
  )
}
