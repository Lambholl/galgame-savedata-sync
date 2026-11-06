import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolveAppVersion } from '../../scripts/app-version.mjs'

export default defineConfig({
  base: './',
  // 共享包的 APP_VERSION 读取这个常量；开发服务器只在启动时计算一次版本。
  define: { SAVEDATA_SYNC_VERSION: JSON.stringify(resolveAppVersion().name) },
  plugins: [react()],
  build: { target: 'chrome89' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
