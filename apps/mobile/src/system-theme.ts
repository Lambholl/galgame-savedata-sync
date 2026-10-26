import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'

/** 同步 antd-mobile 的官方主题属性；返回清理函数供热更新或页面所有者释放监听。 */
export function startSystemTheme(): () => void {
  const preference = window.matchMedia('(prefers-color-scheme: dark)')
  const isAndroid = Capacitor.getPlatform() === 'android'
  let nativeDarkMode: boolean | undefined
  const updateTheme = (): void => {
    const isDarkMode = nativeDarkMode ?? preference.matches
    document.documentElement.dataset.prefersColorScheme = isDarkMode ? 'dark' : 'light'
    document.documentElement.style.colorScheme = isDarkMode ? 'dark' : 'light'
    if (isAndroid) {
      // 显式同步图标颜色；原生配置比部分 WebView 缓存的媒体查询更可靠。
      SystemBars.setStyle({
        style: isDarkMode ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
      }).catch((error: unknown) => {
        console.error('Failed to update Android system bars', error)
      })
    }
  }
  const updateNativeTheme = (event: Event): void => {
    if ('dark' in event && typeof event.dark === 'boolean') {
      nativeDarkMode = event.dark
      updateTheme()
    }
  }
  if (isAndroid) window.addEventListener('savedata:theme-change', updateNativeTheme)
  preference.addEventListener('change', updateTheme)
  updateTheme()
  return () => {
    preference.removeEventListener('change', updateTheme)
    window.removeEventListener('savedata:theme-change', updateNativeTheme)
  }
}
