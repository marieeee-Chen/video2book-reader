import { createReleaseSource, safeContentPath } from './release-source.ts'
/** Read-only folder adapter; v3 integrity rules also apply to local bytes. */
export function createLocalDirSource(readFile: (path: string, signal?: AbortSignal) => Promise<Uint8Array>) {
  const origin = 'https://local-release.invalid/'
  return createReleaseSource({ manifestUrl: origin + 'manifest.json', fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== new URL(origin).origin) throw new Error('本地资料不会自动访问外部仓库')
    let path = decodeURIComponent(url.pathname.slice(1))
    if (path.startsWith('releases/')) path = path.split('/').slice(2).join('/')
    if (!safeContentPath(path)) throw new Error('本地资料路径无效')
    const data = await readFile(path, init?.signal ?? undefined)
    return new Response(data as BodyInit)
  } })
}
