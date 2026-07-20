import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// renderer builds to dist/; electron loads it in prod, the :5173 dev server when CRATE_DEV=1
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
