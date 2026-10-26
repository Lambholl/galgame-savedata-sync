import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startSystemTheme } from './system-theme'
import './style.css'

// 在首次挂载前设置主题，避免已经处于暗色模式的设备先绘制浅色组件。
const stopSystemTheme = startSystemTheme()
if (import.meta.hot) {
  import.meta.hot.dispose(stopSystemTheme)
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Application root element is missing')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
