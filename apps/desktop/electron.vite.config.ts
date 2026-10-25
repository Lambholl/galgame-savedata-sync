import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  },
  renderer: { plugins: [react()] },
})
