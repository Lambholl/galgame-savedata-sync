import { useEffect, useRef, useState } from 'react'
import { Button, List } from 'antd-mobile'
import { APP_LOCALES, APP_VERSION, LOCALE_NAMES, toShownError } from '@savedata-sync/shared'
import type {
  AppPreferences,
  LibraryGame,
  LocalePreference,
  ShownError,
  ThemePreference,
} from '@savedata-sync/shared'
import { useT } from '@savedata-sync/shared/ui'
import { useFailureMessage } from '../../app/failure-message'
import { setNomediaSetting, useNomedia } from '../../app/nomedia'
import { useAllFilesAccess } from '../../app/use-all-files-access'
import type { MobileSyncAdapter } from '../../platform/sync-adapter'
import { BackupKeepCountField } from '../../components/BackupKeepCountField'
import { ChoiceItem } from '../../components/ChoiceItem'
import { SwitchItem } from '../../components/SwitchItem'

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** 应用设置：外观、备份库的保留份数、存储权限和自动添加 .nomedia，改动立即保存。 */
export function SettingsPage({
  sync,
  games,
  preferences,
  onChange,
  onOverlayChange,
}: {
  readonly sync: MobileSyncAdapter
  /** 游戏库里的全部游戏；打开自动添加 .nomedia 时为它们补上，并按 ID 显示添加失败的游戏名。 */
  readonly games: readonly LibraryGame[]
  readonly preferences: AppPreferences
  readonly onChange: (next: AppPreferences) => void
  readonly onOverlayChange: (close: (() => void) | null) => void
}): React.JSX.Element {
  const t = useT()
  /** 备份库的保留份数；读取中或读取失败为 null。 */
  const [keepCount, setKeepCount] = useState<number | null>(null)
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
          setKeepCount(settings.keepCount)
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent) {
          setKeepCount(null)
          setBackupError({ context: t('backup.readFailed'), error: toShownError(cause) })
        }
      })
    return () => {
      isCurrent = false
    }
  }, [sync, version, t])
  const directAccess = useAllFilesAccess()
  const nomedia = useNomedia()
  const nomediaFailures = games.filter((game) => nomedia.failedGameIds.includes(game.id))
  function changeNomedia(shouldAddNomedia: boolean): void {
    setNomediaSetting(shouldAddNomedia, games).catch((cause: unknown) => {
      showFailure(toShownError(cause), t('settings.saveFailed'))
    })
  }
  function openDirectAccessSettings(): void {
    directAccess.openSettings().catch((cause: unknown) => {
      setBackupError({ context: t('directAccess.openFailed'), error: toShownError(cause) })
    })
  }
  function changeKeepCount(next: number): void {
    setKeepCount(next)
    setBackupError(null)
    saving.current = saving.current
      .then(() => sync.setBackupKeepCount(next))
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
      {backupError && keepCount === null ? (
        <div className="empty-state">
          <p>{backupError.context}</p>
          <Button size="small" onClick={() => setVersion((value) => value + 1)}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {keepCount === null ? null : (
        <List mode="card" header={t('settings.backup')}>
          <BackupKeepCountField keepCount={keepCount} onChange={changeKeepCount} />
        </List>
      )}
      {directAccess.isGranted !== null && (
        <List mode="card" header={t('settings.storage')}>
          {/* 应用不能自己开关这项权限，开关只反映当前状态，点按跳到系统授权页。 */}
          <SwitchItem
            title={t('settings.directAccess')}
            isChecked={directAccess.isGranted}
            isDisabled={directAccess.isOpening}
            onChange={openDirectAccessSettings}
          />
          <SwitchItem
            title={t('settings.addNomedia')}
            isChecked={nomedia.shouldAddNomedia}
            onChange={changeNomedia}
          />
          {nomediaFailures.length > 0 ? (
            <List.Item
              description={nomediaFailures.map((game) => (
                <div key={game.id}>{game.name}</div>
              ))}
            >
              {t('settings.addNomediaFailed')}
            </List.Item>
          ) : null}
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
