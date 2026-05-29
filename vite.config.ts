import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const MOBILE_HOST = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: MOBILE_HOST ?? false,
    hmr: MOBILE_HOST ? { protocol: 'ws', host: MOBILE_HOST, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] }
  }
})
