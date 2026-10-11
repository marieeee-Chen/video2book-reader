import type { ContentSource, DocumentInfo } from '../types.ts'
import { splitDocument, type DocPart } from '../model/split-document.ts'
export function createContentQuery(source: ContentSource) {
  const parsed = new Map<string, { info: DocumentInfo; text: string; chapters: DocPart[]; title: string }>()
  async function getDocument(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const info = await source.documentInfo?.(id, signal)
    if (!info?.document.sha256) throw new Error('内容查询需要固定版本正文')
    const key = `${info.document.document_uid}:${info.document.sha256}`
    const cached = parsed.get(key)
    if (cached) { signal?.throwIfAborted(); return cached }
    // Independent in-flight reads: one caller's abort must not cancel another turn.
    const text = await source.loadDocument(id, signal), split = splitDocument(text)
    const doc = { info, text, chapters: split.chapters, title: split.title }
    signal?.throwIfAborted(); parsed.set(key, doc); return doc
  }
  return {
    source, getDocument,
    async getChapter(id: string, chapterIndex: number, signal?: AbortSignal) {
      const doc = await getDocument(id, signal)
      if (!doc.chapters.length && chapterIndex === 1) return { title: doc.title, markdown: doc.text, chapterIndex: 1 }
      const part = doc.chapters.find(p => p.chapterIndex === chapterIndex)
      if (!part) throw new Error('当前版本没有该章')
      return part
    },
    async listDocuments(courseId: string, signal?: AbortSignal) { signal?.throwIfAborted(); const course = await source.loadCourse(courseId); signal?.throwIfAborted(); return course.documents },
    async searchDocument(id: string, query: string, signal?: AbortSignal) {
      const doc = await getDocument(id, signal), results: { chapterIndex: number; title: string; text: string }[] = []
      const chapters = doc.chapters.length ? doc.chapters : [{ chapterIndex: 1, title: doc.title, markdown: doc.text }]
      for (const part of chapters) {
        signal?.throwIfAborted()
        let offset = 0
        while (query && (offset = part.markdown.toLowerCase().indexOf(query.toLowerCase(), offset)) >= 0 && results.length < 30) {
          results.push({ chapterIndex: part.chapterIndex, title: part.title, text: part.markdown.slice(Math.max(0, offset - 100), offset + query.length + 200) }); offset += query.length
        }
      }
      return results
    },
  }
}
export type ContentQuery = ReturnType<typeof createContentQuery>
