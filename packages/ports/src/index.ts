export type NetRequest = { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }
export type NetResponse = { ok: boolean; status: number; statusText: string; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null }
export type NetPort = { fetch(req: NetRequest): Promise<NetResponse> }
export type SecretPort = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export type StorePort = { get(table: string, key: string): Promise<unknown | undefined>; put(table: string, key: string, value: unknown): Promise<void>; delete(table: string, key: string): Promise<void>; getAll(table: string): Promise<unknown[]>; query(table: string, opts: { index?: string; range?: IDBKeyRange; limit?: number }): Promise<unknown[]> }
export type FsPort = { readText(path: string): Promise<string>; writeText(path: string, data: string): Promise<void>; exists(path: string): Promise<boolean>; listDir(path: string): Promise<{ name: string; isDir: boolean; size: number }[]>; mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>; remove(path: string, opts?: { recursive?: boolean }): Promise<void> }
export type NotifyPort = { notify(title: string, body: string): void }
export type Ports = { net: NetPort; secret: SecretPort; store: StorePort; fs?: FsPort; notify?: NotifyPort }
export function memoryStore(): StorePort {
  const tables = new Map<string, Map<string, unknown>>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)! }
  return {
    async get(t, k) { return structuredClone(table(t).get(k)) },
    async put(t, k, v) { table(t).set(k, structuredClone(v)) },
    async delete(t, k) { table(t).delete(k) },
    async getAll(t) { return structuredClone([...table(t).values()]) },
    async query(t, opts) {
      const values = [...table(t).values()].filter(v => !opts.range || opts.range.includes(opts.index ? (v as Record<string, unknown>)[opts.index] : v))
      return structuredClone(opts.limit ? values.slice(0, opts.limit) : values)
    },
  }
}
export function memorySecrets(): SecretPort {
  const data = new Map<string, string>()
  return { async get(k) { return data.get(k) }, async set(k, v) { data.set(k, v) }, async delete(k) { data.delete(k) } }
}
export function browserNet(transport: typeof fetch = globalThis.fetch): NetPort {
  return { async fetch(req) {
    const ac = new AbortController(), abort = () => ac.abort(req.signal?.reason)
    req.signal?.throwIfAborted(); req.signal?.addEventListener('abort', abort, { once: true })
    const timer = req.timeoutMs ? setTimeout(() => ac.abort(new Error('请求超时')), req.timeoutMs) : undefined
    const cleanup = () => { clearTimeout(timer); req.signal?.removeEventListener('abort', abort) }
    try {
      const res = await transport(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal })
      if (!res.body) { cleanup(); return { ok: res.ok, status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: null } }
      const reader = res.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const result = await reader.read(); if (result.done) { cleanup(); controller.close() } else controller.enqueue(result.value) }
          catch (error) { cleanup(); controller.error(error) }
        },
        async cancel(reason) { ac.abort(reason); cleanup(); await reader.cancel(reason) },
      })
      return { ok: res.ok, status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body }
    } catch (error) { cleanup(); throw error }
  } }
}
