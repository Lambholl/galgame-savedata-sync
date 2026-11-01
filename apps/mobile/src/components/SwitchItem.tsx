import { List, Switch } from 'antd-mobile'

/**
 * 设置列表里的开关行：点整行切换，按下时整行变色。
 * 开关本身不处理点击，点到开关也由整行切换，避免切换两次。
 */
export function SwitchItem({
  title,
  isChecked,
  isDisabled = false,
  onChange,
}: {
  readonly title: string
  readonly isChecked: boolean
  readonly isDisabled?: boolean
  readonly onChange: (isChecked: boolean) => void
}): React.JSX.Element {
  return (
    <List.Item
      clickable
      arrowIcon={false}
      disabled={isDisabled}
      extra={<Switch checked={isChecked} disabled={isDisabled} aria-label={title} />}
      onClick={() => onChange(!isChecked)}
    >
      {title}
    </List.Item>
  )
}
