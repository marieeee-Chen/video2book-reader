import { safeContentPath, sha256, type ContentSource, type CourseDetail } from '@app/reader'
import { buildZip, type ZipEntry } from './zip.ts'
export type Progress = { done: number; total: number; error?: string; incomplete?: boolean }
export function saveTextFile(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void { saveBlob(filename, new Blob([text], { type: mime })) }
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
export function fileNameOf(id: string): string { return id.slice(id.lastIndexOf('/') + 1) }
export type DownloadHandle = { progress: Progress; cancel: () => void; completion: Promise<void> }
export async function courseArchiveEntries(course: CourseDetail, source: ContentSource, signal: AbortSignal, report: () => void): Promise<{ entries: ZipEntry[]; incomplete: boolean }> {
  const entries: ZipEntry[] = [], encoder = new TextEncoder(), paths = new Set<string>()
  const add = (name: string, data: Uint8Array) => {
    if (!safeContentPath(name) || paths.has(name)) throw new Error(`下载路径冲突或越界：${name}`)
    paths.add(name); entries.push({ name, data })
  }
  for (const doc of course.documents) {
    signal.throwIfAborted()
    const text = await source.loadDocument(doc.id, signal)
    add(doc.path ?? doc.id, encoder.encode(text)); report()
  }
  for (const asset of course.assets ?? []) {
    signal.throwIfAborted()
    if (!source.loadAsset) throw new Error('此内容源不支持完整图片下载')
    add(asset.path, await source.loadAsset(asset.path, signal)); report()
  }
  const incomplete = !!course.external_assets?.length || !!course.missing_assets?.length || !source.releaseId
  const files = await Promise.all(entries.map(async e => ({ path: e.name, bytes: e.data.length, sha256: await sha256(e.data) })))
  const pack = { schema_version: 1, course_uid: course.course_uid, release_id: await source.releaseId?.(), delivery_scope: course.delivery_scope,
    scope_description: course.scope_description, complete: !incomplete, missing_external_assets: course.external_assets ?? [], missing_assets: course.missing_assets ?? [], files }
  add('download-manifest.json', encoder.encode(JSON.stringify(pack, null, 2) + '\n'))
  return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), incomplete }
}
export function downloadCourseZip(course: CourseDetail, source: ContentSource, onProgress: (p: Progress) => void): DownloadHandle {
  const ac = new AbortController(), progress: Progress = { done: 0, total: course.documents.length + (course.assets?.length ?? 0) + 1 }
  const report = () => onProgress({ ...progress })
  report()
  const completion = (async () => {
    try {
      const archive = await courseArchiveEntries(course, source, ac.signal, () => { progress.done++; report() })
      const zip = await buildZip(archive.entries); ac.signal.throwIfAborted()
      progress.incomplete = archive.incomplete
      saveBlob(`${course.title}${archive.incomplete ? '-不完整' : ''}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }))
    } catch (error) { progress.error = ac.signal.aborted ? '下载已取消' : `下载未完成：${String(error)}` }
    progress.done = progress.total; report()
  })()
  return { progress, completion, cancel: () => ac.abort() }
}
