import { useEffect, useState } from 'react'
import { ConfigProvider, theme } from 'antd'
import { themeTokens } from '@savedata-sync/shared'
import type { ResolvedTheme } from '@savedata-sync/shared'
import { MobileApp } from './app/MobileApp'
import { androidBackButton } from './app/back-button'
import { createMobileLibraryAdapter } from './platform/library-adapter'
import { createMobileSyncAdapter, hasAndroidSyncWork } from './platform/sync-adapter'

const ADAPTER = createMobileLibraryAdapter({ hasSyncWork: hasAndroidSyncWork })
const SYNC = createMobileSyncAdapter(ADAPTER)

function readTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Android 入口，保留同一个连接与原生任务适配器。 */
export function App(): React.JSX.Element {
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
  return (
    <ConfigProvider
      theme={{
        algorithm: resolvedTheme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: themeTokens(resolvedTheme),
      }}
    >
      <MobileApp adapter={ADAPTER} sync={SYNC} backButton={androidBackButton} />
    </ConfigProvider>
  )
}
