import { useEffect, useRef, useState } from 'react'
import { Button, List } from 'antd-mobile'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES, toShownError } from '@savedata-sync/shared'
import type {
  AppPreferences,
  LocalePreference,
  ShownError,
  SyncBackupPolicy,
  ThemePreference,
} from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import { BackupPolicyFields } from '../../components/BackupPolicyFields'
import { ChoiceItem } from '../../components/ChoiceItem'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** 应用设置：外观与全局备份设置，改动立即保存。 */
export function SettingsPage({
  sync,
  preferences,
  onChange,
  onOverlayChange,
}: {
  readonly sync: MobileSyncAdapter
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
  readonly onOverlayChange: (close: (() => void) | null) => void
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
  /** 保存依次进行，连续点击时后一次等前一次写完。 */
  const saving = useRef(Promise.resolve())
  // 失败用 Message 提示一次；读不到设置时留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(backupError?.error ?? null, backupError?.context ?? null)
  }, [backupError, showFailure])
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
          setBackupError({ context: t('backup.readFailed'), error: toShownError(cause) })
        }
      })
    return () => {
      isCurrent = false
    }
  }, [sync, version, t])
  function changePolicy(next: SyncBackupPolicy): void {
    setPolicy(next)
    setBackupError(null)
    saving.current = saving.current
      .then(() => sync.setBackupDefaults(next))
      .catch((cause: unknown) => {
        setBackupError({ context: t('backup.saveFailed'), error: toShownError(cause) })
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
          onOverlayChange={onOverlayChange}
        />
        <ChoiceItem<ThemePreference>
          title={t('settings.theme')}
          options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
          value={preferences.theme}
          onChange={(theme) => onChange({ ...preferences, theme })}
          onOverlayChange={onOverlayChange}
        />
      </List>
      {failureHolder}
      {backupError && !policy && (
        <div className="empty-state">
          <p>{backupError.context}</p>
          <Button size="small" onClick={() => setVersion((value) => value + 1)}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {policy && (
        <List mode="card" header={t('settings.backup')}>
          <BackupPolicyFields policy={policy} isDisabled={false} onChange={changePolicy} />
        </List>
      )}
      <List mode="card" header={t('settings.about')}>
        <List.Item extra={<span className="ss-copyable">{APP_VERSION}</span>}>
          {t('settings.version')}
        </List.Item>
      </List>
    </>
  )
}
