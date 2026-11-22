import { defineConfig } from 'vite'
import { resolveAppVersion } from '../../scripts/app-version.mjs'

// sidecar 打成单个文件，运行时只依赖 Node 内置模块，第三方包全部打进产物。
// 用 CommonJS：发布版用 @yao-pkg/pkg 把它打进可执行文件，pkg 直接打包 CommonJS 入口，ES 模块入口要先经它转换。
export default defineConfig({
  define: { SAVEDATA_SYNC_VERSION: JSON.stringify(resolveAppVersion().name) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/sidecar/index.ts',
    outDir: 'out/sidecar',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.cjs', format: 'cjs' } },
  },
})
