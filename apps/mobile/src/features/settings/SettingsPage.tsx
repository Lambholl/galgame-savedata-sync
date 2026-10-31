import { Segmented } from 'antd'
import { Selector } from 'antd-mobile'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES } from '@savedata-sync/shared'
import type { AppPreferences, LocalePreference, ThemePreference } from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { Panel } from '../../components/Panel'

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
      <Panel title={t('settings.appearance')}>
        <p>{t('settings.theme')}</p>
        <Segmented<ThemePreference>
          block
          size="large"
          options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
          value={preferences.theme}
          onChange={(theme) => onChange({ ...preferences, theme })}
        />
        <p>{t('settings.language')}</p>
        <Selector<LocalePreference>
          columns={2}
          options={[
            { value: 'system', label: t('settings.language.system') },
            ...APP_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
          ]}
          value={[preferences.locale]}
          onChange={([locale]) => {
            if (locale) {
              onChange({ ...preferences, locale })
            }
          }}
        />
      </Panel>
      <Panel title={t('settings.about')}>
        <p>
          {t('settings.version')} {APP_VERSION}
        </p>
      </Panel>
    </>
  )
}
