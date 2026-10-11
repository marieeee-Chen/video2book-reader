import * as fs from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import type { FsPort } from '../../../packages/ports/src/index.ts'
function safe(path: string) { if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.')) throw new Error('denied'); return path }
export function desktopFs(): FsPort {
  const path = async (name: string) => join(await appDataDir(), safe(name))
  return {
    async readText(name) { return fs.readTextFile(await path(name)) },
    async writeText(name, data) { const dest = await path(name), temp = dest + '.' + crypto.randomUUID() + '.tmp'; try { await fs.writeTextFile(temp, data); await fs.rename(temp, dest) } catch (e) { await fs.remove(temp).catch(() => undefined); throw e } },
    async exists(name) { return fs.exists(await path(name)) },
    async listDir(name) { const dir = await path(name); return Promise.all((await fs.readDir(dir)).map(async e => ({ name: e.name, isDir: e.isDirectory, size: (await fs.stat(await join(dir, e.name))).size }))) },
    async mkdir(name, opts) { await fs.mkdir(await path(name), opts) },
    async remove(name, opts) { await fs.remove(await path(name), opts) },
  }
}
