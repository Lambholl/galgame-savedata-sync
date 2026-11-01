import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Form, Select } from 'antd'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES, toShownError, unwrap } from '@savedata-sync/shared'
import type {
  AppPreferences,
  LocalePreference,
  ShownError,
  SyncBackupPolicy,
  ThemePreference,
} from '@savedata-sync/shared'
import { ErrorText, useT } from '@savedata-sync/shared/ui'
import { desktopBackups } from '../../platform/sync-adapter.ts'
import { BackupPolicyFields } from '../backup/BackupPolicyFields.tsx'
import { SETTING_FORM } from './setting-form.ts'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** 应用设置：外观与全局备份设置，改动立即保存。 */
export function SettingsPage({
  preferences,
  onChange,
}: {
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
}): React.JSX.Element {
  const t = useT()
  /** 全局备份设置；读取中或读取失败为 null。 */
  const [policy, setPolicy] = useState<SyncBackupPolicy | null>(null)
  /** 读取或保存备份设置的失败，连同出错的操作。 */
  const [backupError, setBackupError] = useState<{
    readonly context: string
    readonly error: ShownError
  } | null>(null)
  const [version, setVersion] = useState(0)
  /** 保存依次进行，连续调整时后一次等前一次写完。 */
  const saving = useRef(Promise.resolve())
  useEffect(() => {
    let isCurrent = true
    desktopBackups()
      .read()
      .then((result) => {
        const { defaults } = unwrap(result).settings
        if (isCurrent) {
          setPolicy(defaults)
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setPolicy(null)
          setBackupError({ context: t('backup.readFailed'), error: toShownError(cause) })
        }
      })
    return () => {
      isCurrent = false
    }
  }, [version, t])
  function changePolicy(next: SyncBackupPolicy): void {
    setPolicy(next)
    setBackupError(null)
    saving.current = saving.current
      .then(async () => {
        unwrap(await desktopBackups().setDefaults(next))
      })
      .catch((cause: unknown) => {
        setBackupError({ context: t('backup.saveFailed'), error: toShownError(cause) })
        setVersion((value) => value + 1)
      })
  }
  return (
    <div className="settings-column">
      <Card title={t('settings.appearance')}>
        <Form {...SETTING_FORM}>
          <Form.Item label={t('settings.language')}>
            <Select<LocalePreference>
              value={preferences.locale}
              options={[
                { value: 'system', label: t('settings.language.system') },
                ...APP_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
              ]}
              onChange={(locale) => onChange({ ...preferences, locale })}
            />
          </Form.Item>
          <Form.Item label={t('settings.theme')}>
            <Select<ThemePreference>
              value={preferences.theme}
              options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
              onChange={(theme) => onChange({ ...preferences, theme })}
            />
          </Form.Item>
        </Form>
      </Card>
      <Card title={t('settings.backup')}>
        {backupError && (
          <Alert
            showIcon
            type="error"
            title={<ErrorText error={backupError.error} context={backupError.context} />}
            action={
              !policy && (
                <Button size="small" onClick={() => setVersion((value) => value + 1)}>
                  {t('common.retry')}
                </Button>
              )
            }
          />
        )}
        {policy && (
          <Form {...SETTING_FORM}>
            <BackupPolicyFields policy={policy} isDisabled={false} onChange={changePolicy} />
          </Form>
        )}
      </Card>
      <Card title={t('settings.about')}>
        <Form {...SETTING_FORM}>
          <Form.Item label={t('settings.version')}>
            <span className="ss-copyable">{APP_VERSION}</span>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
