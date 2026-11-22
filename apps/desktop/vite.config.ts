import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { resolveAppVersion } from '../../scripts/app-version.mjs'

// 界面页面。开发服务器的地址要和 src-tauri/tauri.conf.json 的 devUrl 一致。
export default defineConfig({
  root: fileURLToPath(new URL('src/renderer', import.meta.url)),
  base: './',
  define: { SAVEDATA_SYNC_VERSION: JSON.stringify(resolveAppVersion().name) },
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('out/renderer', import.meta.url)),
    emptyOutDir: true,
    // 页面随主程序从本地加载，不经网络下载，单个大文件不影响加载速度。
    chunkSizeWarningLimit: 2048,
  },
})
