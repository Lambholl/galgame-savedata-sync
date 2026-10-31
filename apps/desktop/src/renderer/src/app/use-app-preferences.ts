import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_APP_PREFERENCES, resolveLocale } from '@savedata-sync/shared'
import type { AppLocale, AppPreferences, ResolvedTheme } from '@savedata-sync/shared'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 当前界面偏好及据此解析出的主题与语言。 */
export interface AppPreferencesState {
  readonly preferences: AppPreferences
  readonly theme: ResolvedTheme
  readonly locale: AppLocale
  /** 保存新偏好；失败时恢复原值并返回错误消息。 */
  readonly save: (next: AppPreferences) => Promise<string | null>
}

/**
 * 主进程按偏好设置 nativeTheme.themeSource，渲染页的 prefers-color-scheme 随之变化，
 * 因此主题直接读媒体查询；同时把解析结果写到 <html data-theme> 供共用样式使用。
 */
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
  const theme: ResolvedTheme = isDark ? 'dark' : 'light'
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const save = useCallback(
    async (next: AppPreferences): Promise<string | null> => {
      const previous = preferences
      setPreferences(next)
      const result = await window.desktopPreferences?.save(next)
      if (result?.status === 'error') {
        setPreferences(previous)
        return result.error.message
      }
      return null
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
