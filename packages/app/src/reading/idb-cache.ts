/** Storage failures degrade to online reading; identities/hashes are verified by the content source. */
const DB_NAME = 'course-reader'
const VERSION = 2
let dbPromise: Promise<IDBDatabase> | undefined
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      for (const name of ['content', 'releaseIndex', 'assets']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { dbPromise = undefined; reject(request.error) }
    request.onblocked = () => { dbPromise = undefined; reject(new Error('请关闭其他阅读器窗口以升级缓存')) }
  })
  return dbPromise
}
async function get<T>(store: string, key: string): Promise<T | undefined> {
  try {
    const db = await openDb()
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  } catch { return undefined }
}
async function set(store: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch { /* Online reading remains available without persistent storage. */ }
}
export const contentCache = {
  async get(key: string, expectedSize?: number): Promise<string | undefined> {
    const record = await get<{ text: string }>('content', key)
    if (!record || (expectedSize !== undefined && new TextEncoder().encode(record.text).length !== expectedSize)) return undefined
    return record.text
  },
  set(key: string, text: string) { return set('content', key, { text }) },
}
export const indexCache = { get: (key: string) => get<string>('releaseIndex', key), set: (key: string, text: string) => set('releaseIndex', key, text) }
export const assetCache = { get: (key: string) => get<Uint8Array>('assets', key), set: (key: string, data: Uint8Array) => set('assets', key, data) }
