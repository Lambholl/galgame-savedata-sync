import { useEffect, useRef, useState } from 'react'
import { Button, Empty, Form } from 'antd'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES, toShownError, unwrap } from '@savedata-sync/shared'
import type {
  AppPreferences,
  LocalePreference,
  ShownError,
  ThemePreference,
} from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import type { DesktopBackupInfo } from '../../../../bridge/backup-bridge.ts'
import { useFailureMessage } from '../../app/failure-message.ts'
import type { Confirmation } from '../../app/navigation.ts'
import { ConfirmationDialog } from '../../components/ConfirmationDialog.tsx'
import { desktopBackups } from '../../platform/sync-adapter.ts'
import { BackupKeepCountField } from './BackupKeepCountField.tsx'
import { BackupLibraryRow } from './BackupLibraryRow.tsx'
import { SETTING_FORM } from './setting-form.ts'
import { SettingSelect } from './SettingSelect.tsx'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** 应用设置页：外观、备份库的保留份数和位置，改动立即保存。 */
export function SettingsPage({
  preferences,
  onChange,
}: {
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
}): React.JSX.Element {
  const t = useT()
  /** 备份库的保留份数；读取中或读取失败为 null。 */
  const [keepCount, setKeepCount] = useState<number | null>(null)
  /** 备份库的位置和状态；读取中或读取失败为 null。 */
  const [library, setLibrary] = useState<DesktopBackupInfo | null>(null)
  /** 等待确认的更换位置操作。 */
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [isRelocating, setIsRelocating] = useState(false)
  /** 读取或保存备份设置的失败，连同出错的操作。 */
  const [backupError, setBackupError] = useState<{
    readonly context: string
    readonly error: ShownError
  } | null>(null)
  const [version, setVersion] = useState(0)
  /** 保存依次进行，连续调整时后一次等前一次写完。 */
  const saving = useRef(Promise.resolve())
  // 失败用 Message 提示一次；读不到设置时这一节留一个重试入口。
  const [showFailure, failureHolder] = useFailureMessage()
  useEffect(() => {
    showFailure(backupError?.error ?? null, backupError?.context ?? null)
  }, [backupError, showFailure])
  useEffect(() => {
    let isCurrent = true
    desktopBackups()
      .read()
      .then((result) => {
        const info = unwrap(result)
        if (isCurrent) {
          setKeepCount(info.settings.keepCount)
          setLibrary(info)
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setKeepCount(null)
          setLibrary(null)
          setBackupError({ context: t('backup.readFailed'), error: toShownError(cause) })
        }
      })
    return () => {
      isCurrent = false
    }
  }, [version, t])
  function changeKeepCount(next: number): void {
    setKeepCount(next)
    setBackupError(null)
    saving.current = saving.current
      .then(async () => {
        unwrap(await desktopBackups().setKeepCount(next))
      })
      .catch((cause: unknown) => {
        setBackupError({ context: t('backup.saveFailed'), error: toShownError(cause) })
        setVersion((value) => value + 1)
      })
  }
  /** 先提示已有备份不会搬走，确认后再选文件夹或换回默认位置。 */
  function askRelocate(action: 'chooseLocation' | 'resetLocation'): void {
    setConfirmation({
      title: t(
        action === 'chooseLocation' ? 'backup.changeLibraryTitle' : 'backup.resetLibraryTitle',
      ),
      text: t('backup.changeLibraryText'),
      work: async () => {
        const next = unwrap(await desktopBackups()[action]())
        if (next) {
          setLibrary(next)
        }
      },
    })
  }
  function handleConfirm(): void {
    const work = confirmation?.work
    // 先关掉确认框，系统目录选择器打开时界面上不再留着它。
    setConfirmation(null)
    if (!work) {
      return
    }
    setIsRelocating(true)
    setBackupError(null)
    work()
      .catch((cause: unknown) => {
        const error = toShownError(cause)
        setBackupError({
          context: t('backup.changeLibraryFailed'),
          error:
            error.code === 'path-outside-root'
              ? { code: null, message: t('backup.libraryOverlaps') }
              : error,
        })
      })
      .finally(() => setIsRelocating(false))
  }
  return (
    <div className="settings-column">
      <section className="settings-section">
        <h2>{t('settings.appearance')}</h2>
        <Form {...SETTING_FORM}>
          <Form.Item label={t('settings.language')}>
            <SettingSelect<LocalePreference>
              label={t('settings.language')}
              value={preferences.locale}
              options={[
                { value: 'system', label: t('settings.language.system') },
                ...APP_LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
              ]}
              onChange={(locale) => onChange({ ...preferences, locale })}
            />
          </Form.Item>
          <Form.Item label={t('settings.theme')}>
            <SettingSelect<ThemePreference>
              label={t('settings.theme')}
              value={preferences.theme}
              options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
              onChange={(theme) => onChange({ ...preferences, theme })}
            />
          </Form.Item>
        </Form>
      </section>
      <section className="settings-section">
        <h2>{t('settings.backup')}</h2>
        {failureHolder}
        {backupError && keepCount === null ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={backupError.context}>
            <Button onClick={() => setVersion((value) => value + 1)}>{t('common.retry')}</Button>
          </Empty>
        ) : null}
        {keepCount === null ? null : (
          <Form {...SETTING_FORM}>
            <BackupKeepCountField keepCount={keepCount} onChange={changeKeepCount} />
          </Form>
        )}
        {library ? (
          <BackupLibraryRow
            path={library.displayPath}
            isCustom={library.isCustomLocation}
            isAvailable={library.isLocationAvailable}
            disabled={isRelocating}
            onChange={() => askRelocate('chooseLocation')}
            onReset={() => askRelocate('resetLocation')}
          />
        ) : null}
        <ConfirmationDialog
          confirmation={confirmation}
          isBusy={false}
          onCancel={() => setConfirmation(null)}
          onConfirm={handleConfirm}
        />
      </section>
      <section className="settings-section">
        <h2>{t('settings.about')}</h2>
        <Form {...SETTING_FORM}>
          <Form.Item label={t('settings.version')}>
            <span className="ss-copyable">{APP_VERSION}</span>
          </Form.Item>
        </Form>
      </section>
    </div>
  )
}
