import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
/** Shell-only build assembly: absent business plugins produce a working empty runtime. */
export function businessPlugins(root: string) {
  return { name: 'business-plugins', resolveId(id: string) { if (id === 'virtual:business-plugins') return '\0business-plugins' }, load(id: string) {
    if (id !== '\0business-plugins') return
    const entries = [['loadStudy', 'study'], ['loadModels', 'custom-model']]
    return entries.map(([loader, name]) => {
      const path = resolve(root, 'plugins', name, 'src/index.ts')
      return `export const ${loader} = ${existsSync(path) ? `() => import(${JSON.stringify(path)})` : 'async () => null'};`
    }).join('\n')
  } }
}
