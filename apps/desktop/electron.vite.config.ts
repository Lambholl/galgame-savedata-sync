import react from '@vitejs/plugin-react'
import { defineConfig, type UserConfig } from 'electron-vite'
import { createServer } from 'node:net'

const rendererHost = '127.0.0.1'

// electron-vite 用配置中的端口拼 ELECTRON_RENDERER_URL，不读实际监听端口，
// 所以不能直接写 port: 0；先向系统申请空闲端口，再用 strictPort 固定。
function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      probe.close(() => {
        if (address !== null && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('无法获取渲染进程开发服务器端口'))
        }
      })
    })
  })
}

export default defineConfig(async ({ command }): Promise<UserConfig> => ({
  main: { build: { externalizeDeps: { exclude: ['@savedata-sync/shared'] } } },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@savedata-sync/shared'] },
      rollupOptions: {
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    ...(command === 'serve' && {
      server: { host: rendererHost, port: await findFreePort(rendererHost), strictPort: true },
    }),
  },
}))
