import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { businessPlugins } from '../../scripts/business-plugins.ts'
import tailwindcss from '@tailwindcss/vite'
const root = fileURLToPath(new URL('../..', import.meta.url))

// Tauri 在 dev 时用固定端口；strictPort 让端口被占用时直接失败，而不是悄悄换端口
// （换了端口 Tauri 就找不到 devServer，症状会变得难查）
const DEV_PORT = 5173

export default defineConfig({
  plugins: [react(), tailwindcss(), businessPlugins(root)],
  resolve: { alias: [{ find: '@app/reader/styles.css', replacement: resolve(root, 'packages/reader/src/styles.css') }, { find: '@app/reader', replacement: resolve(root, 'packages/reader/src/index.ts') }] },
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  // Tauri 的构建产物目录
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 桌面端只需要面向 WebView2（Windows 10/11），不必为老浏览器降级
    target: 'chrome110',
    sourcemap: true,
  },
})
