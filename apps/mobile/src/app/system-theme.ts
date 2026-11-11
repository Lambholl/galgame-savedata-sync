import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { resolveTheme } from '@savedata-sync/shared'
import { getAppPreferences, subscribeAppPreferences } from './app-preferences'

/**
 * 按主题偏好与系统明暗设置 <html> 的 data-theme 和 data-prefers-color-scheme，并跟随变化。
 *
 * @returns 停止跟随的函数。
 */
export function startSystemTheme(): () => void {
  const preference = window.matchMedia('(prefers-color-scheme: dark)')
  const isAndroid = Capacitor.getPlatform() === 'android'
  let isNativeDarkMode: boolean | undefined
  const updateTheme = (): void => {
    const theme = resolveTheme(getAppPreferences().theme, isNativeDarkMode ?? preference.matches)
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.prefersColorScheme = theme
    document.documentElement.style.colorScheme = theme
    if (isAndroid) {
      // 显式同步图标颜色；原生配置比部分 WebView 缓存的媒体查询更可靠。
      SystemBars.setStyle({
        style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
      }).catch((error: unknown) => {
        console.error('Failed to update Android system bars', error)
      })
    }
  }
  const updateNativeTheme = (event: Event): void => {
    if ('dark' in event && typeof event.dark === 'boolean') {
      isNativeDarkMode = event.dark
      updateTheme()
    }
  }
  if (isAndroid) {
    window.addEventListener('savedata:theme-change', updateNativeTheme)
  }
  preference.addEventListener('change', updateTheme)
  const unsubscribe = subscribeAppPreferences(updateTheme)
  updateTheme()
  return () => {
    preference.removeEventListener('change', updateTheme)
    window.removeEventListener('savedata:theme-change', updateNativeTheme)
    unsubscribe()
  }
}
