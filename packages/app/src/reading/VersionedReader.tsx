import { useEffect, useState } from 'react'
import { Reader, type ContentSource, type DocumentInfo, type ReaderApi, type ReadingEvents, type ReaderSlots } from '@app/reader'
import { createPositionStore } from './reading-position.ts'
function localStore() { try { return localStorage } catch { return undefined } }
export const positionStore = createPositionStore(localStore())
export function VersionedReader({ contentSource, documentId, apiRef, events, slots }: { contentSource: ContentSource; documentId: string; apiRef?: { current: ReaderApi | null }; events?: ReadingEvents; slots?: ReaderSlots }) {
  const [info, setInfo] = useState<DocumentInfo>()
  const [error, setError] = useState('')
  useEffect(() => {
    const ac = new AbortController()
    setInfo(undefined); setError('')
    if (!contentSource.documentInfo) { setInfo({ document: { id: documentId, kind: 'volume', title: '', size: 0, originIndex: 0 }, courseId: '' }); return }
    void contentSource.documentInfo(documentId, ac.signal).then(i => { if (!ac.signal.aborted) setInfo(i) }).catch(e => { if (!ac.signal.aborted) setError(String(e)) })
    return () => ac.abort()
  }, [contentSource, documentId])
  if (error) return <div className="reader-status reader-status-error">{error}</div>
  if (!info) return <div className="reader-status">正在核对内容版本…</div>
  const saved = positionStore.get(info)
  return <>
    {saved.stale && <div role="status" className="version-notice">正文已更新，上次位置保留在旧版本；从本版章首开始。</div>}
    <Reader key={`${documentId}:${info.document.sha256}`} contentSource={contentSource} documentId={documentId} apiRef={apiRef} slots={slots}
      initialBlockId={saved.position?.blockId} initialChapterIndex={saved.stale ? 1 : saved.position?.chapterIndex}
      events={{ ...events, onScrollAnchor: (id, chapterIndex, blockId) => { positionStore.put(info, { chapterIndex, blockId }); events?.onScrollAnchor?.(id, chapterIndex, blockId) } }} />
  </>
}
