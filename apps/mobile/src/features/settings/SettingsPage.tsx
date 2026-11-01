import { useEffect, useRef, useState } from 'react'
import { Button, List } from 'antd-mobile'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES } from '@savedata-sync/shared'
import type {
  AppPreferences,
  LocalePreference,
  SyncBackupPolicy,
  ThemePreference,
} from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import { BackupPolicyFields } from '../../components/BackupPolicyFields'
import { ChoiceItem } from '../../components/ChoiceItem'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** 应用设置：外观与全局备份设置，改动立即保存。 */
export function SettingsPage({
  sync,
  preferences,
  onChange,
}: {
  readonly sync: MobileSyncAdapter
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
}): React.JSX.Element {
  const t = useT()
  /** 全局备份设置；读取中或读取失败为 null。 */
  const [policy, setPolicy] = useState<SyncBackupPolicy | null>(null)
  const [backupError, setBackupError] = useState('')
  const [version, setVersion] = useState(0)
  /** 保存依次进行，连续点击时后一次等前一次写完。 */
  const saving = useRef(Promise.resolve())
  useEffect(() => {
    let isCurrent = true
    sync
      .backupSettings()
      .then((settings) => {
        if (isCurrent) {
          setPolicy(settings.defaults)
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setPolicy(null)
          setBackupError(
            t('backup.readFailed', {
              message: cause instanceof Error ? cause.message : t('common.unknown'),
            }),
          )
        }
      })
    return () => {
      isCurrent = false
    }
  }, [sync, version, t])
  function changePolicy(next: SyncBackupPolicy): void {
    setPolicy(next)
    setBackupError('')
    saving.current = saving.current
      .then(() => sync.setBackupDefaults(next))
      .catch((cause: unknown) => {
        setBackupError(
          t('backup.saveFailed', {
            message: cause instanceof Error ? cause.message : t('common.unknown'),
          }),
        )
        setVersion((value) => value + 1)
      })
  }
  return (
    <>
      <List mode="card" header={t('settings.appearance')}>
        <ChoiceItem<LocalePreference>
          title={t('settings.language')}
          options={[
            { value: 'system', label: t('settings.language.system') },
            ...APP_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
          ]}
          value={preferences.locale}
          onChange={(locale) => onChange({ ...preferences, locale })}
        />
        <ChoiceItem<ThemePreference>
          title={t('settings.theme')}
          options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
          value={preferences.theme}
          onChange={(theme) => onChange({ ...preferences, theme })}
        />
      </List>
      {backupError && (
        <div className="notice notice-error" role="alert">
          <p>{backupError}</p>
          {!policy && (
            <div className="action-row">
              <Button size="small" onClick={() => setVersion((value) => value + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          )}
        </div>
      )}
      {policy && (
        <List mode="card" header={t('settings.backup')}>
          <BackupPolicyFields policy={policy} isDisabled={false} onChange={changePolicy} />
        </List>
      )}
      <List mode="card" header={t('settings.about')}>
        <List.Item extra={APP_VERSION}>{t('settings.version')}</List.Item>
      </List>
    </>
  )
}
