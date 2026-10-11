import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { businessPlugins } from '../../scripts/business-plugins.ts'
import tailwindcss from '@tailwindcss/vite'
const root = fileURLToPath(new URL('../..', import.meta.url))
export default defineConfig({ plugins: [react(), tailwindcss(), businessPlugins(root)], resolve: { alias: [{ find: '@app/reader/styles.css', replacement: resolve(root, 'packages/reader/src/styles.css') }, { find: '@app/reader', replacement: resolve(root, 'packages/reader/src/index.ts') }] }, server: { port: 5175 }, build: { target: 'chrome110', sourcemap: true } })
