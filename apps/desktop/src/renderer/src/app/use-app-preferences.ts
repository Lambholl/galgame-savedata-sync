import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_APP_PREFERENCES,
  OperationFailure,
  resolveLocale,
  resolveTheme,
  toShownError,
  unwrap,
} from '@savedata-sync/shared'
import type { AppLocale, AppPreferences, ResolvedTheme, ShownError } from '@savedata-sync/shared'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 当前界面偏好及据此解析出的主题与语言。 */
export interface AppPreferencesState {
  readonly preferences: AppPreferences
  readonly theme: ResolvedTheme
  readonly locale: AppLocale
  /** 保存新偏好；失败时恢复原值并返回错误消息。 */
  readonly save: (next: AppPreferences) => Promise<ShownError | null>
}

// 选了浅色或深色时直接用偏好，不读媒体查询：Linux 上 WebKitGTK 的 prefers-color-scheme 跟着 GTK 主题，
// 宿主设置窗口明暗只改 GTK 的深色偏好，GTK 主题本身是深色时界面仍会报深色。
/** 读取和保存界面偏好，并把解析出的主题写到 <html data-theme>。 */
export function useAppPreferences(): AppPreferencesState {
  const [preferences, setPreferences] = useState(DEFAULT_APP_PREFERENCES)
  const [isDark, setIsDark] = useState(() => window.matchMedia(DARK_QUERY).matches)
  useEffect(() => {
    let isCurrent = true
    window.desktopPreferences
      ?.read()
      .then((result) => {
        if (isCurrent && result.status === 'success') {
          setPreferences(result.value)
        }
      })
      .catch((error: unknown) => console.error('Failed to read app preferences', error))
    return () => {
      isCurrent = false
    }
  }, [])
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY)
    const update = (): void => setIsDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const theme: ResolvedTheme = resolveTheme(preferences.theme, isDark)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const save = useCallback(
    async (next: AppPreferences): Promise<ShownError | null> => {
      const previous = preferences
      setPreferences(next)
      try {
        if (!window.desktopPreferences) {
          throw new OperationFailure(
            'unsupported-operation',
            'Appearance preferences require the desktop app.',
          )
        }
        unwrap(await window.desktopPreferences.save(next))
        return null
      } catch (cause) {
        setPreferences(previous)
        return toShownError(cause)
      }
    },
    [preferences],
  )
  return {
    preferences,
    theme,
    locale: resolveLocale(preferences.locale, navigator.languages),
    save,
  }
}
