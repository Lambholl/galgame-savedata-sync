import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from './App'
import { createTranslator, resolveLocale } from '@savedata-sync/shared'
import type { VersionedDataItem } from '@savedata-sync/shared'
import { installDesignTokens } from '@savedata-sync/shared/ui'
import { getAppPreferences, loadAppPreferences } from './app/app-preferences'
import { loadNomediaSetting } from './app/nomedia'
import { loadAppStorage, readNewerData } from './platform/app-storage'
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

// 数据由更新版本写入时原生层只注册了偏好和存储插件，这里只显示提示，不挂载应用，也不读写游戏配置。
function showNewerData(items: readonly VersionedDataItem[]): void {
  const t = createTranslator(resolveLocale(getAppPreferences().locale, navigator.languages))
  document.title = t('app.name')
  const notice = document.createElement('div')
  notice.className = 'startup-error startup-notice'
  const title = document.createElement('h1')
  title.className = 'startup-notice-title'
  title.textContent = t('newerData.title')
  const intro = document.createElement('p')
  intro.textContent = t('newerData.intro')
  const list = document.createElement('ul')
  list.className = 'startup-notice-list'
  for (const item of items) {
    const entry = document.createElement('li')
    entry.textContent = t(`newerData.item.${item}`)
    list.append(entry)
  }
  const hint = document.createElement('p')
  hint.textContent = t('newerData.hint')
  notice.append(title, intro, list, hint)
  root.replaceChildren(notice)
}

// 偏好决定首屏主题与语言，游戏配置供首屏读取；两者读取完成（或失败回落）后再挂载。
Promise.all([loadAppPreferences(), readNewerData()])
  .then(async ([, newer]) => {
    if (newer.length > 0) {
      showNewerData(newer)
      finishStartup()
      return
    }
    await Promise.all([loadAppStorage(), loadNomediaSetting()])
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
