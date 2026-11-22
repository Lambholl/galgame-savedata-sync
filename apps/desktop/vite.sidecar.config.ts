import { defineConfig } from 'vite'
import { resolveAppVersion } from '../../scripts/app-version.mjs'

// sidecar 打成单个 ESM 文件，运行时只依赖 Node 内置模块，第三方包全部打进产物。
export default defineConfig({
  define: { SAVEDATA_SYNC_VERSION: JSON.stringify(resolveAppVersion().name) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/sidecar/index.ts',
    outDir: 'out/sidecar',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.mjs', format: 'es' } },
  },
})
