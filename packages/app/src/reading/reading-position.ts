import type { DocumentInfo } from '@app/reader'
const KEY = 'cr-positions-v2'
export type ReadingPosition = { document_uid: string; sha256: string; release_id?: string; chapterIndex: number; blockId: string; visited: boolean }
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function positionKey(info: DocumentInfo): string { return `${info.document.document_uid ?? info.document.id}@${info.document.sha256 ?? 'preview'}` }
export function createPositionStore(storage?: Storage) {
  let records: Record<string, ReadingPosition> = {}
  try { records = JSON.parse(storage?.getItem(KEY) ?? '{}') as Record<string, ReadingPosition> } catch { /* unavailable */ }
  return {
    get(info: DocumentInfo) {
      const current = records[positionKey(info)]
      const stale = !current && Object.values(records).some(p => p.document_uid === info.document.document_uid && p.sha256 !== info.document.sha256)
      return { position: current, stale }
    },
    put(info: DocumentInfo, position: { chapterIndex: number; blockId: string }) {
      if (!info.document.sha256 || !info.document.document_uid) return
      records[positionKey(info)] = { ...position, document_uid: info.document.document_uid, sha256: info.document.sha256, release_id: info.release_id, visited: true }
      try { storage?.setItem(KEY, JSON.stringify(records)) } catch { /* memory state survives during this run */ }
    },
    visited(info: DocumentInfo) { return !!records[positionKey(info)]?.visited },
  }
}
