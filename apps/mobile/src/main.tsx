import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from './App'
import { createTranslator, resolveLocale } from '@savedata-sync/shared'
import { installDesignTokens } from '@savedata-sync/shared/ui'
import { getAppPreferences, loadAppPreferences } from './app/app-preferences'
import { loadAppStorage } from './platform/app-storage'
import { finishStartup } from './platform/launch-animation'
import { startSystemTheme } from './app/system-theme'
import { startPressFeedback } from './app/press-feedback'
import './styles/mobile.css'

installDesignTokens()

// 先按系统明暗设置主题；读到已保存的偏好后由订阅自动更新。
const stopSystemTheme = startSystemTheme()
const stopPressFeedback = startPressFeedback()
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopSystemTheme()
    stopPressFeedback()
  })
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Application root element is missing')
}
const root = container

// 偏好决定首屏主题与语言，游戏配置供首屏读取；两者读取完成（或失败回落）后再挂载。
Promise.all([loadAppPreferences(), loadAppStorage()])
  .then(() => {
    // 先提交 React 首屏，再让原生等待 WebView 绘制；开屏淡出时，页面内容已经就绪。
    flushSync(() => {
      createRoot(root).render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
    })
    finishStartup()
  })
  .catch((error: unknown) => {
    // 读不到已保存的配置时不挂载应用，避免以空配置启动后覆盖已保存的数据。
    console.error('Failed to start mobile app', error)
    const t = createTranslator(resolveLocale(getAppPreferences().locale, navigator.languages))
    document.title = t('app.name')
    const notice = document.createElement('p')
    notice.className = 'startup-error'
    notice.textContent = t('app.startFailed')
    root.replaceChildren(notice)
    finishStartup()
  })
