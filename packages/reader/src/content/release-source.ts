import type { AssetSummary, ContentSource, CourseDetail, DocumentInfo, DocumentSummary, Manifest, ManifestCourse, TitleHit } from '../types.ts'
import type { DocumentCache } from './github-source.ts'

export type ReleaseIndexCache = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
export type ReleaseSourceOptions = {
  manifestUrl: string
  releaseId?: string
  cache?: DocumentCache
  indexCache?: ReleaseIndexCache
  assetCache?: { get(key: string): Promise<Uint8Array | undefined>; set(key: string, data: Uint8Array): Promise<void> }
  fetch?: typeof globalThis.fetch
  /** Optional override only for serving an isolated candidate; official manifests carry a versioned base. */
  candidateBaseUrl?: string
}

const HASH = /^[0-9a-f]{64}$/
export function safeContentPath(path: string): boolean {
  return !!path && !path.startsWith('/') && !/[\\?#]/.test(path) && path.split('/').every(p => p !== '..' && p !== '.' && p !== '' && p !== '.git')
}
export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
async function verified(data: Uint8Array, size: number, expected: string): Promise<void> {
  if (data.byteLength !== size || await sha256(data) !== expected) throw new Error('内容版本校验失败，请重新取得本发布版本')
}
function allDocs(course: ManifestCourse): DocumentSummary[] { return [...course.volumes, ...course.notes, ...course.subtitles] }
function detail(course: ManifestCourse): CourseDetail {
  const { volumes, notes, subtitles, ...meta } = course
  return { ...meta, volumeCount: volumes.length, noteCount: notes.length, subtitleCount: subtitles.length, documents: allDocs(course) }
}
export function validateReleaseManifest(manifest: Manifest, expectedRelease?: string): void {
  if (manifest.manifestVersion !== 3 || !manifest.release_id || !/^[\w.-]+$/.test(manifest.release_id)) throw new Error('需要兼容的冻结发布清单（v3）')
  if (expectedRelease && manifest.release_id !== expectedRelease) throw new Error('发布版本不匹配')
  if (!manifest.reader_compatibility || manifest.reader_compatibility.min > 3 || manifest.reader_compatibility.max < 3) throw new Error('此发布需要升级阅读器')
  if (manifest.content_base !== `releases/${manifest.release_id}/courses/`) throw new Error('发布正文必须使用同源固定版本地址')
  const courses = new Set<string>(), uids = new Set<string>(), paths = new Set<string>(), docUids = new Set<string>()
  for (const course of manifest.courses) {
    if (!course.course_uid || courses.has(course.id) || uids.has(course.course_uid) || !course.scope_description || !course.source_role) throw new Error('课程身份或公开范围无效')
    courses.add(course.id); uids.add(course.course_uid)
    for (const doc of allDocs(course)) {
      if (!doc.document_uid || !doc.sha256 || !HASH.test(doc.sha256) || !safeContentPath(doc.path ?? doc.id) || !safeContentPath(doc.id) || paths.has(doc.id) || docUids.has(doc.document_uid)) throw new Error('正文身份、路径或指纹无效')
      if (!doc.source || !safeContentPath(doc.source.path) || !doc.source.repo_id || !['owned_publish', 'readonly_upstream', 'source_archive'].includes(doc.source.role)) throw new Error('正文来源无效')
      if (!doc.product_type || !['article', 'textbook', 'note', 'transcript', 'mindmap', 'asset', 'legacy_unknown'].includes(doc.product_type) || (doc.product_type === 'legacy_unknown' && doc.source.role !== 'source_archive')) throw new Error('正文产品类型无效')
      if (doc.source.commit && !/^[0-9a-f]{40}$/.test(doc.source.commit)) throw new Error('正文来源必须绑定固定提交')
      if (!Number.isSafeInteger(doc.size) || doc.size < 0) throw new Error('无效正文大小')
      paths.add(doc.id); docUids.add(doc.document_uid)
    }
    for (const asset of course.assets ?? []) {
      if (!safeContentPath(asset.path) || !HASH.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error('图片路径或指纹无效')
    }
  }
  for (const [old, target] of Object.entries(manifest.aliases?.courses ?? {})) if (!old || !courses.has(target)) throw new Error('课程旧链接映射无效')
  for (const [old, target] of Object.entries(manifest.aliases?.documents ?? {})) if (!safeContentPath(old) || !paths.has(target)) throw new Error('正文旧链接映射无效')
}

/** One instance selects one snapshot. Failure never switches to a moving Git branch. */
export function createReleaseSource(opts: ReleaseSourceOptions): ContentSource {
  const fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const absoluteManifest = new URL(opts.manifestUrl, typeof location === 'undefined' ? 'http://localhost/' : location.href)
  let manifest: Manifest | undefined
  let selected: Promise<Manifest> | undefined
  const docs = new Map<string, DocumentInfo>()
  const assets = new Map<string, AssetSummary>()
  async function getManifest(): Promise<Manifest> {
    selected ??= (async () => {
      const key = `release-index:${absoluteManifest}:${opts.releaseId ?? 'selected'}`
      let text: string
      try {
        const res = await fetcher(absoluteManifest, { cache: 'no-cache' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        text = await res.text()
      } catch (error) {
        const saved = await opts.indexCache?.get(key).catch(() => undefined)
        if (!saved) throw new Error(`书架版本不可用，需要联网：${String(error)}`)
        text = saved
      }
      const data = JSON.parse(text) as Manifest
      validateReleaseManifest(data, opts.releaseId)
      // Cache only compatible validated structure. Invalid network data never selects an older cached version.
      await opts.indexCache?.set(key, text).catch(() => undefined)
      manifest = data
      for (const course of data.courses) {
        for (const document of allDocs(course)) docs.set(document.id, { document, courseId: course.id, release_id: data.release_id })
        for (const asset of course.assets ?? []) {
          const previous = assets.get(asset.path)
          if (previous && previous.sha256 !== asset.sha256) throw new Error('发布图片冲突')
          assets.set(asset.path, asset)
        }
      }
      return data
    })()
    return selected
  }
  function resolveDoc(id: string): string { return manifest?.aliases?.documents[id] ?? id }
  function contentUrl(path: string): string {
    if (!safeContentPath(path)) throw new Error('无效内容路径')
    const base = opts.candidateBaseUrl ? new URL(opts.candidateBaseUrl, absoluteManifest) : new URL(manifest!.content_base!, absoluteManifest)
    return new URL(path.split('/').map(encodeURIComponent).join('/'), base).href
  }
  async function documentInfo(id: string, signal?: AbortSignal): Promise<DocumentInfo> {
    signal?.throwIfAborted()
    await getManifest(); signal?.throwIfAborted()
    const info = docs.get(resolveDoc(id))
    if (!info) throw new Error('此正文未包含在所选发布范围中')
    return info
  }
  return {
    documentInfo,
    async releaseId() { return (await getManifest()).release_id! },
    async listCourses() { return (await getManifest()).courses.map(c => { const { documents: _documents, ...summary } = detail(c); return summary }) },
    async listCategories() { return (await getManifest()).categories },
    async loadCourse(id) {
      const index = await getManifest()
      const course = index.courses.find(c => c.id === (index.aliases?.courses[id] ?? id))
      if (!course) throw new Error(`此发布没有这门课程：${id}`)
      return detail(course)
    },
    async loadDocument(id, signal) {
      const { document: doc } = await documentInfo(id, signal)
      const key = `${doc.document_uid}:${doc.sha256}`
      const cached = await opts.cache?.get(key).catch(() => undefined)
      if (cached !== undefined) {
        try { await verified(new TextEncoder().encode(cached), doc.size, doc.sha256!); signal?.throwIfAborted(); return cached }
        catch (e) { if (signal?.aborted) throw e }
      }
      const attempts = [contentUrl(doc.path ?? doc.id)]
      const source = doc.source!
      if (source.github && source.commit) {
        const { owner, name } = source.github
        if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new Error('无效仓库定位')
        attempts.push(`https://raw.githubusercontent.com/${owner}/${name}/${source.commit}/${source.path.split('/').map(encodeURIComponent).join('/')}`)
      }
      for (const url of attempts) {
        signal?.throwIfAborted()
        try {
          const response = await fetcher(url, { signal })
          if (!response.ok) continue
          const bytes = new Uint8Array(await response.arrayBuffer())
          await verified(bytes, doc.size, doc.sha256!)
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
          signal?.throwIfAborted()
          await opts.cache?.set(key, text).catch(() => undefined)
          return text
        } catch (error) { if (signal?.aborted) throw error }
      }
      throw new Error('所选版本正文不可用或哈希不符；需联网取得相同版本')
    },
    documentUrl(id) {
      const doc = docs.get(resolveDoc(id))?.document
      if (!doc || !manifest) throw new Error('正文尚未加载')
      return contentUrl(doc.path ?? doc.id)
    },
    async loadAsset(path, signal) {
      await getManifest(); signal?.throwIfAborted()
      const asset = assets.get(path)
      if (!asset) throw new Error('图片未包含在所选发布范围')
      const key = `asset:${asset.sha256}`
      const cached = await opts.assetCache?.get(key).catch(() => undefined)
      if (cached) {
        try { await verified(cached, asset.bytes, asset.sha256); signal?.throwIfAborted(); return cached }
        catch (error) { if (signal?.aborted) throw error }
      }
      const res = await fetcher(contentUrl(path), { signal })
      if (!res.ok) throw new Error('此版本图片需要联网取得')
      const data = new Uint8Array(await res.arrayBuffer())
      await verified(data, asset.bytes, asset.sha256); signal?.throwIfAborted()
      await opts.assetCache?.set(key, data).catch(() => undefined)
      return data
    },
    async searchTitles(query, signal) {
      const index = await getManifest(), q = query.trim().toLowerCase(), hits: TitleHit[] = []
      if (!q) return hits
      for (const c of index.courses) {
        signal?.throwIfAborted()
        if (c.title.toLowerCase().includes(q)) hits.push({ courseId: c.id, courseTitle: c.title, kind: 'course', title: c.title })
        for (const d of allDocs(c)) if (d.title.toLowerCase().includes(q)) hits.push({ courseId: c.id, courseTitle: c.title, documentId: d.id, kind: d.kind, title: d.title })
      }
      return hits
    },
  }
}
