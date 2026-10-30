import { Card } from 'antd'

export function SettingsPage(): React.JSX.Element {
  return (
    <>
      <Card title="外观">
        <p>主题：跟随系统</p>
      </Card>
      <Card title="存档同步">
        <p>版本 0.1.2</p>
      </Card>
    </>
  )
}
