import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Test runner config for the Vue/Tauri frontend.
//
// Kept separate from `vite.config.ts` so test-only concerns (happy-dom
// environment, globals) never leak into the production build, and so
// `tauri build` doesn't pick up a test-only plugin chain.
export default defineConfig({
  plugins: [vue()],
  test: {
    // happy-dom instead of jsdom: smaller and faster, and it provides the
    // Date/Date.now behaviour the stale-threshold tests depend on.
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.spec.ts'],
    // Surfaces unhandled rejections in the component tree instead of
    // silently passing — Vue emits errors through this channel.
    reporters: ['default'],
    clearMocks: true,
    restoreMocks: true,
  },
})
