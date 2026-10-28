import { useEffect, useState } from 'react'
import { ConfigProvider, theme } from 'antd'
import { MobileApp } from './app/MobileApp'
import { androidBackButton } from './app/back-button'
import { createMobileLibraryAdapter } from './platform/library-adapter'
import { createMobileSyncAdapter, hasAndroidSyncWork } from './platform/sync-adapter'

const ADAPTER = createMobileLibraryAdapter({ hasSyncWork: hasAndroidSyncWork })
const SYNC = createMobileSyncAdapter(ADAPTER)

/** Android 入口，保留同一个连接与原生任务适配器。 */
export function App(): React.JSX.Element {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.dataset.prefersColorScheme === 'dark',
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.dataset.prefersColorScheme === 'dark')
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-prefers-color-scheme'],
    })
    return () => observer.disconnect()
  }, [])
  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#286add', borderRadius: 12 },
      }}
    >
      <MobileApp adapter={ADAPTER} sync={SYNC} backButton={androidBackButton} />
    </ConfigProvider>
  )
}
