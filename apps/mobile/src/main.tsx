import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadAppPreferences } from './app/app-preferences'
import { startSystemTheme } from './app/system-theme'
import '@savedata-sync/shared/ui/tokens.css'
import './styles/mobile.css'

// 先按系统明暗设置主题；读到已保存的偏好后由订阅自动更新。
const stopSystemTheme = startSystemTheme()
if (import.meta.hot) {
  import.meta.hot.dispose(stopSystemTheme)
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Application root element is missing')
}
const root = container

// 偏好决定首屏主题与语言，读取完成（或失败回落默认值）后再挂载。
loadAppPreferences()
  .then(() => {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
  .catch((error: unknown) => console.error('Failed to start mobile app', error))
