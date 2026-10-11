import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { browserNet, memorySecrets, type NetPort, type NetResponse, type SecretPort, type FsPort } from '../../../packages/ports/src/index.ts'
export type StreamEvent = { requestId: string; kind: 'chunk' | 'done' | 'error'; data?: string; error?: string }
const NativeStream = registerPlugin<{ start(options: { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<Omit<NetResponse, 'body'>>; cancel(options: { requestId: string }): Promise<void>; addListener(name: 'stream', listener: (event: StreamEvent) => void): Promise<PluginListenerHandle> }>('ReaderStream')
const NativeSecrets = registerPlugin<{ get(options: { key: string }): Promise<{ value?: string }>; set(options: { key: string; value: string }): Promise<void>; remove(options: { key: string }): Promise<void> }>('ReaderSecrets')
export function mobileSecrets(): SecretPort {
  if (!Capacitor.isNativePlatform()) return memorySecrets()
  return { async get(key) { return (await NativeSecrets.get({ key })).value }, async set(key, value) { await NativeSecrets.set({ key, value }) }, async delete(key) { await NativeSecrets.remove({ key }) } }
}
export function mobileNet(): NetPort {
  if (!Capacitor.isNativePlatform()) return browserNet()
  return { async fetch(req) {
    // Capacitor's local bundle is a WebView origin, not an HTTP server for Java.
    if ((req.method ?? 'GET') === 'GET' && new URL(req.url).origin === location.origin) return browserNet().fetch(req)
    req.signal?.throwIfAborted()
    const requestId = crypto.randomUUID()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined, ended = false
    const buffered: StreamEvent[] = []
    let listener: PluginListenerHandle | undefined
    const abort = () => { ended = true; controller?.error(req.signal?.reason ?? new DOMException('Stopped', 'AbortError')); void NativeStream.cancel({ requestId }); void listener?.remove() }
    const deliver = (event: StreamEvent) => {
      if (ended || !controller) return
      if (event.kind === 'chunk') { const raw = atob(event.data ?? ''); controller.enqueue(Uint8Array.from(raw, c => c.charCodeAt(0))) }
      else { ended = true; if (event.kind === 'done') controller.close(); else controller.error(new Error('原生请求失败')); req.signal?.removeEventListener('abort', abort); void listener?.remove() }
    }
    listener = await NativeStream.addListener('stream', event => { if (event.requestId !== requestId) return; if (controller) deliver(event); else buffered.push(event) })
    if (req.signal?.aborted) { await listener.remove(); req.signal.throwIfAborted() }
    req.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await NativeStream.start({ requestId, url: req.url, method: req.method ?? 'GET', headers: req.headers ?? {}, body: req.body, timeoutMs: req.timeoutMs ?? 120000 })
      req.signal?.throwIfAborted()
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; for (const event of buffered) deliver(event) }, async cancel() { ended = true; req.signal?.removeEventListener('abort', abort); await NativeStream.cancel({ requestId }); await listener?.remove() } })
      return { ...response, body }
    } catch (error) { ended = true; req.signal?.removeEventListener('abort', abort); await listener.remove(); await NativeStream.cancel({ requestId }).catch(() => undefined); throw error }
  } }
}
function path(name: string) { if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.')) throw new Error('denied'); return name }
export function mobileFs(): FsPort {
  return {
    async readText(name) { return String((await Filesystem.readFile({ path: path(name), directory: Directory.Data, encoding: Encoding.UTF8 })).data) },
    async writeText(name, data) { const dest = path(name), temp = dest + '.' + crypto.randomUUID() + '.tmp'; await Filesystem.writeFile({ path: temp, directory: Directory.Data, encoding: Encoding.UTF8, data }); await Filesystem.rename({ from: temp, to: dest, directory: Directory.Data }) },
    async exists(name) { try { await Filesystem.stat({ path: path(name), directory: Directory.Data }); return true } catch { return false } },
    async listDir(name) { const { files } = await Filesystem.readdir({ path: path(name), directory: Directory.Data }); return files.map(f => ({ name: f.name, isDir: f.type === 'directory', size: f.size })) },
    async mkdir(name, opts) { await Filesystem.mkdir({ path: path(name), directory: Directory.Data, recursive: opts?.recursive }) },
    async remove(name, opts) { const p = path(name), stat = await Filesystem.stat({ path: p, directory: Directory.Data }); if (stat.type === 'directory') await Filesystem.rmdir({ path: p, directory: Directory.Data, recursive: opts?.recursive }); else await Filesystem.deleteFile({ path: p, directory: Directory.Data }) },
  }
}
