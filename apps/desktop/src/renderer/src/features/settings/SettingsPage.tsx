import { Card, Segmented, Select } from 'antd'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES } from '@savedata-sync/shared'
import type { AppPreferences, LocalePreference, ThemePreference } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

export function SettingsPage({
  preferences,
  onChange,
}: {
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <Card title={t('settings.appearance')}>
        <div className="library-setting-row">
          <span>{t('settings.theme')}</span>
          <Segmented<ThemePreference>
            options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
            value={preferences.theme}
            onChange={(theme) => onChange({ ...preferences, theme })}
          />
        </div>
        <div className="library-setting-row">
          <span>{t('settings.language')}</span>
          <Select<LocalePreference>
            className="library-setting-select"
            value={preferences.locale}
            options={[
              { value: 'system', label: t('settings.language.system') },
              ...APP_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
            ]}
            onChange={(locale) => onChange({ ...preferences, locale })}
          />
        </div>
      </Card>
      <Card title={t('settings.about')}>
        <p>
          {t('settings.version')} {APP_VERSION}
        </p>
      </Card>
    </>
  )
}
