import type { StorePort } from '../../ports/src/index.ts'
export function indexedStore(name = 'course-reader-runtime'): StorePort {
  let opening: Promise<IDBDatabase> | undefined
  function db() {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 2)
      let rejected = false
      req.onupgradeneeded = () => {
        for (const table of ['threads', 'turns', 'models', 'settings']) {
          if (req.result.objectStoreNames.contains(table)) continue
          const store = req.result.createObjectStore(table)
          if (table === 'threads') store.createIndex('scope', ['scope.kind', 'scope.key'])
        }
      }
      req.onsuccess = () => {
        if (rejected) { req.result.close(); return }
        req.result.onversionchange = () => { req.result.close(); opening = undefined }
        resolve(req.result)
      }
      req.onerror = () => { opening = undefined; reject(req.error) }
      req.onblocked = () => { rejected = true; opening = undefined; reject(new Error('会话库升级被其他窗口阻挡')) }
    })
    return opening
  }
  async function request<T>(table: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await db()
    return new Promise((resolve, reject) => {
      const tx = database.transaction(table, mode), req = action(tx.objectStore(table))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  return {
    get: (t, k) => request(t, 'readonly', s => s.get(k)),
    async put(t, k, v) { await request(t, 'readwrite', s => s.put(v, k)) },
    async delete(t, k) { await request(t, 'readwrite', s => s.delete(k)) },
    getAll: t => request(t, 'readonly', s => s.getAll()),
    query: (t, opts) => request(t, 'readonly', s => (opts.index ? s.index(opts.index) : s).getAll(opts.range, opts.limit)),
  }
}
