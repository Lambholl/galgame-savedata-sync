/** 主题偏好：跟随系统，或固定浅色/深色。 */
export type ThemePreference = 'system' | 'light' | 'dark'
/** 实际使用的明暗主题。 */
export type ResolvedTheme = 'light' | 'dark'
/** 界面支持的语言。 */
export type AppLocale = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP'
/** 语言偏好：跟随系统，或固定一种界面语言。 */
export type LocalePreference = 'system' | AppLocale

/** 两端各自保存在本机的界面偏好；不跨设备同步。 */
export interface AppPreferences {
  readonly theme: ThemePreference
  readonly locale: LocalePreference
}

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']
export const APP_LOCALES: readonly AppLocale[] = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP']
export const DEFAULT_APP_PREFERENCES: AppPreferences = { theme: 'system', locale: 'system' }

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((item) => item === value)
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || APP_LOCALES.some((item) => item === value)
}

/** 封闭对象校验：只接受恰好两个已知字段。 */
export function isAppPreferences(value: unknown): value is AppPreferences {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'theme' in value &&
    'locale' in value &&
    isThemePreference(value.theme) &&
    isLocalePreference(value.locale)
  )
}

/**
 * 读取已保存的偏好；缺少或无效的字段回落到默认值，不抛错。
 * 用于本机存储被手工修改或来自旧版本的情况。
 */
export function parseAppPreferences(value: unknown): AppPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_APP_PREFERENCES
  }
  const theme = 'theme' in value && isThemePreference(value.theme) ? value.theme : 'system'
  const locale = 'locale' in value && isLocalePreference(value.locale) ? value.locale : 'system'
  return { theme, locale }
}

export function resolveTheme(preference: ThemePreference, isSystemDark: boolean): ResolvedTheme {
  if (preference === 'system') {
    return isSystemDark ? 'dark' : 'light'
  }
  return preference
}

/**
 * 按系统语言列表（如 navigator.languages）选界面语言：取第一个能对应的语言。
 * 繁体（zh-TW、zh-HK、zh-MO、zh-Hant）用 zh-TW，其余中文用 zh-CN；都不匹配时用 en-US。
 */
export function resolveLocale(
  preference: LocalePreference,
  systemLanguages: readonly string[],
): AppLocale {
  if (preference !== 'system') {
    return preference
  }
  for (const language of systemLanguages) {
    const tag = language.toLowerCase()
    if (tag.startsWith('zh')) {
      return /^zh-(?:tw|hk|mo|hant)\b/.test(tag) ? 'zh-TW' : 'zh-CN'
    }
    if (tag.startsWith('ja')) {
      return 'ja-JP'
    }
    if (tag.startsWith('en')) {
      return 'en-US'
    }
  }
  return 'en-US'
}
