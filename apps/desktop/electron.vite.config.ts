import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ['@savedata-sync/shared'] } } },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@savedata-sync/shared'] },
      rollupOptions: {
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  },
  renderer: { plugins: [react()] },
})
