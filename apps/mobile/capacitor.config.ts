import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.galgame.savedatasync',
  appName: '存档同步',
  webDir: 'dist',
  // 由原生日夜主题提供加载背景，避免 WebView 默认白底在暗色启动时闪烁。
  android: { backgroundColor: '#00000000' },
  server: { androidScheme: 'http', cleartext: true },
  // 和 index.html 的 viewport-fit=cover 一致；原生层读到页面的声明前就按铺满布局，避免页面跳动。
  plugins: { SystemBars: { initialViewportFitValueHint: 'cover' } },
}

export default config
