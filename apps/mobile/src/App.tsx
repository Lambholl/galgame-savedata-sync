import { useEffect, useState } from 'react'
import { ConfigProvider } from 'antd'
import antdEnUS from 'antd/locale/en_US'
import antdJaJP from 'antd/locale/ja_JP'
import antdZhCN from 'antd/locale/zh_CN'
import antdZhTW from 'antd/locale/zh_TW'
import type { Locale } from 'antd/es/locale'
import { createTranslator, resolveLocale } from '@savedata-sync/shared'
import type { AppLocale, ResolvedTheme } from '@savedata-sync/shared'
import { I18nProvider, designTheme } from '@savedata-sync/shared/ui'
import { MobileApp } from './app/MobileApp'
import { useAppPreferences } from './app/app-preferences'
import { androidBackButton } from './app/back-button'
import { createMobileLibraryAdapter } from './platform/library-adapter'
import { createMobileSyncAdapter, hasAndroidSyncWork } from './platform/sync-adapter'

const ADAPTER = createMobileLibraryAdapter({ hasSyncWork: hasAndroidSyncWork })
const SYNC = createMobileSyncAdapter(ADAPTER)
const ANTD_LOCALES: Readonly<Record<AppLocale, Locale>> = {
  'zh-CN': antdZhCN,
  'zh-TW': antdZhTW,
  'en-US': antdEnUS,
  'ja-JP': antdJaJP,
}

function readTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Android 入口，保留同一个连接与原生任务适配器。 */
export function App(): React.JSX.Element {
  const preferences = useAppPreferences()
  const locale = resolveLocale(preferences.locale, navigator.languages)
  // system-theme 已按偏好与系统设置 data-theme；这里只跟随它切换 antd 主题。
  const [resolvedTheme, setResolvedTheme] = useState(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setResolvedTheme(readTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    document.documentElement.lang = locale
    document.title = createTranslator(locale)('app.name')
  }, [locale])
  return (
    <I18nProvider locale={locale}>
      <ConfigProvider locale={ANTD_LOCALES[locale]} theme={designTheme(resolvedTheme, 'mobile')}>
        <MobileApp adapter={ADAPTER} sync={SYNC} backButton={androidBackButton} />
      </ConfigProvider>
    </I18nProvider>
  )
}
