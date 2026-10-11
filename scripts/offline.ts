import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
/** Build an immutable shell cache. Content is verified separately by ReleaseSource. */
export function offlineShell(out: string) {
  return { name: 'offline-shell', closeBundle() {
    const files: string[] = ['index.html']
    function walk(dir: string, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), name + '/')
        else if (!name.endsWith('.map')) files.push(name)
      }
    }
    walk(join(out, 'assets'), 'assets/')
    const sha = createHash('sha256'); for (const file of files.sort()) { sha.update(file); sha.update(readFileSync(join(out, file))) }
    const version = sha.digest('hex')
    writeFileSync(join(out, 'sw.js'), `// Generated from this shell's exact bytes. No APIs or model requests are cached.
const CACHE = 'reader-shell-${version}', FILES = ${JSON.stringify(files)};
const base = new URL('./', self.location.href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(path => new URL(path, base).href)))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const path = url.pathname.slice(base.pathname.length);
  if (path.startsWith('api/') || path === 'manifest.json' || path.endsWith('.map')) return;
  if (req.mode === 'navigate') { event.respondWith(fetch(req).catch(() => caches.open(CACHE).then(cache => cache.match(new URL('index.html', base).href)))); return; }
  if (!FILES.includes(path) && !new RegExp('^releases/[a-zA-Z0-9_.-]+/courses/').test(path)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req); if (hit) return hit;
    const res = await fetch(req); if (res.ok) await cache.put(req, res.clone()); return res;
  }));
});\n`)
  } }
}
