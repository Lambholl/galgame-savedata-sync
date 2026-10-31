import { Segmented } from 'antd'
import type { AppPreferences, ThemePreference } from '@savedata-sync/shared'
import { Panel } from '../../components/Panel'

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

export function SettingsPage({
  preferences,
  onChange,
}: {
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
}): React.JSX.Element {
  return (
    <>
      <Panel title="外观">
        <p>主题</p>
        <Segmented<ThemePreference>
          block
          size="large"
          options={THEME_OPTIONS}
          value={preferences.theme}
          onChange={(theme) => onChange({ ...preferences, theme })}
        />
      </Panel>
      <Panel title="存档同步">
        <p>版本 0.1.2</p>
      </Panel>
    </>
  )
}
