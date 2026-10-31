import { Card, Segmented } from 'antd'
import type { AppPreferences, ThemePreference } from '@savedata-sync/shared'

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
      <Card title="外观">
        <div className="library-setting-row">
          <span>主题</span>
          <Segmented<ThemePreference>
            options={THEME_OPTIONS}
            value={preferences.theme}
            onChange={(theme) => onChange({ ...preferences, theme })}
          />
        </div>
      </Card>
      <Card title="存档同步">
        <p>版本 0.1.2</p>
      </Card>
    </>
  )
}
