import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Plugin } from 'vite'

/** Keep install assets independent of the user's public content workspace. */
export function pwaAssets(directory: string): Plugin {
  let base = '/'
  return { name: 'pwa-assets', configResolved(config) { base = config.base },
    // Inject after Vite's HTML asset rewriting; manifest-relative icons must stay together.
    transformIndexHtml: { order: 'post', handler() { return [
      { tag: 'link', attrs: { rel: 'manifest', href: base + 'pwa/manifest.json' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'apple-touch-icon', href: base + 'pwa/apple-touch-icon.png' }, injectTo: 'head' },
    ] } }, generateBundle() {
    for (const name of readdirSync(directory)) {
      this.emitFile({ type: 'asset', fileName: `pwa/${name}`, source: readFileSync(join(directory, name)) })
    }
  } }
}

export function staticDemo(directory: string, stageScript: string): Plugin {
  return { name: 'static-demo', closeBundle() {
    if (process.env.READER_DEMO_RELEASE) execFileSync(process.execPath, [stageScript, directory], { stdio: 'inherit' })
  } }
}
