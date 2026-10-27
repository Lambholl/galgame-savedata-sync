import { Panel } from '../../components/Panel'

export function SettingsPage(): React.JSX.Element {
  return (
    <>
      <Panel title="外观">
        <p>主题：跟随系统</p>
      </Panel>
      <Panel title="存档同步">
        <p>版本 0.1.0</p>
      </Panel>
    </>
  )
}
