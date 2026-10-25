/**
 * 阅读器对外类型。契约来源：docs/03-阅读器设计.md §2.1
 *
 * 一条硬约束（docs/00 §4 不变量 3）：本包**不依赖** agent / 插件 / 端口实现 / 任何壳。
 * 静态版就是靠"换掉 2 个端口 + 换 StorePort 装配"得到的，阅读功能一行不改。
 */

import type { ReactNode } from 'react'

export type CourseId = string
export type DocumentId = string

export type CourseCatalogCategory = {
  id: string
  name: string
}

export type CourseCatalogEntry = {
  title: string
  direction: string
  publishPath: string
  categoryPaths: string[]
  tags: string[]
}

export type CourseCatalog = {
  schemaVersion: number
  categories: CourseCatalogCategory[]
  courses: Record<CourseId, CourseCatalogEntry>
}

/** volume = 模块全书（册）；note = 复习笔记；subtitle = 逐字稿（.txt 或块级 .md，无阅读视图） */
export type DocumentKind = 'volume' | 'note' | 'subtitle'

export type ContentProvenance = {
  repo_id: string
  role: 'owned_publish' | 'readonly_upstream' | 'source_archive'
  commit?: string
  path: string
  github?: { owner: string; name: string }
}
export type AssetSummary = { path: string; bytes: number; sha256: string }
export type OrganizationMember = {
  source_availability?: {
    status: string
    disposition?: string
    unlock_labels?: string[]
    user_reported_unlocked_tier_cny?: number
  }
  id: string
  title: string
  kind: 'video' | 'article' | 'unknown'
  document_ids: string[]
  related_card_ids: string[]
  product_types?: string[]
  evidence?: string[]
  cid?: number
}
export type CourseOrganization = {
  display_title?: string
  source_scope_summary?: string
  source_id: string
  source_name: string
  collection_id: string
  collection_title: string
  registered_course: boolean
  accepted_delivery: boolean
  members: OrganizationMember[]
}
export type OrganizationStats = { content_cards: number; registered_courses: number; accepted_deliveries: number }
export type PublicationInfo = {
  organization?: CourseOrganization
  course_uid?: string
  source_role?: ContentProvenance['role']
  delivery_scope?: string
  scope_description?: string
  review_summary?: { decision: string; limitations: string[] }
  assets?: AssetSummary[]
  external_assets?: string[]
  missing_assets?: (string | { path: string; document_id: string })[]
}

export type DocumentSummary = {
  id: DocumentId
  kind: DocumentKind
  title: string
  originIndex: number
  document_uid?: string
  course_uid?: string
  product_type?: 'article' | 'textbook' | 'note' | 'transcript' | 'mindmap' | 'asset' | 'legacy_unknown'
  sha256?: string
  path?: string
  source?: ContentProvenance
  /** 字节数仅用于显示和完整性检查；正文版本以 SHA-256 为准 */
  size: number
}

export type CourseSummary = PublicationInfo & {
  id: CourseId
  title: string
  /** 展示性文案，best-effort，可为空（docs/03 §2.3） */
  direction?: string
  /** 仓库内物理课程目录；有 catalog 时提供 */
  publishPath?: string
  /** 逻辑分类路径；交叉分类可重复出现在不同分类下 */
  categoryPaths?: string[]
  tags?: string[]
  volumeCount: number
  noteCount: number
  /** 逐字稿数量。列表只在 loadCourse 里给（书架不需要） */
  subtitleCount: number
}

export type CourseDetail = CourseSummary & {
  /** 册 + 笔记 + 逐字稿，按 kind 区分（调用方自己分组） */
  documents: DocumentSummary[]
}

// ---- 构建期生成的 manifest（静态站用；桌面版不用，见 docs/03 §2.3）----

export type ManifestCourse = PublicationInfo & {
  id: CourseId
  title: string
  direction: string
  /** 仓库内物理课程目录，catalog v2 提供 */
  publishPath: string
  /** 逻辑主分类与交叉分类路径 */
  categoryPaths: string[]
  tags: string[]
  volumes: DocumentSummary[]
  notes: DocumentSummary[]
  /** 逐字稿：`PXX_*.txt` 或 `BLKxx_*.md`。只列出与下载，不提供阅读视图 */
  subtitles: DocumentSummary[]
  /** 该课程全部产件的字节数（册 + 笔记 + 逐字稿） */
  bytes: number
}

export type Manifest = {
  organization_stats?: OrganizationStats
  manifestVersion: number
  release_id?: string
  content_base?: string
  reader_compatibility?: { min: number; max: number }
  aliases?: { courses: Record<string, string>; documents: Record<string, string> }
  generatedAt: string
  repo?: { owner: string; name: string; ref: string }
  categories: CourseCatalogCategory[]
  stats: { courses: number; volumes: number; notes: number; subtitles: number; bytes: number }
  largestVolume?: { courseId: CourseId; id: DocumentId; size: number }
  courses: ManifestCourse[]
}

// ---- 内容源接缝 ----

/**
 * 结构搜索的一条命中。
 * **只搜标题，不搜正文**——跨库全文检索需要构建期倒排索引，是另一件事（docs/00 §11 D3，v2）。
 * 标题全在已加载的结构里，所以这个查询**零网络、零索引成本**。
 */
export type TitleHit = {
  courseId: CourseId
  /** 课程展示名，用于在结果里标注出处（搜到一册但不知道是哪门课是很糟的体验） */
  courseTitle: string
  /** 命中课程本身时没有 documentId */
  documentId?: DocumentId
  kind: DocumentKind | 'course'
  title: string
}

export type DocumentInfo = { document: DocumentSummary; courseId: string; release_id?: string }
export type ContentSource = {
  organizationStats?(): Promise<OrganizationStats | undefined>
  documentInfo?(id: DocumentId, signal?: AbortSignal): Promise<DocumentInfo>
  releaseId?(): Promise<string>
  loadAsset?(path: string, signal?: AbortSignal): Promise<Uint8Array>
  listCourses(): Promise<CourseSummary[]>
  listCategories(): Promise<CourseCatalogCategory[]>
  loadCourse(id: CourseId): Promise<CourseDetail>
  loadDocument(id: DocumentId, signal?: AbortSignal): Promise<string>
  /** Base URL for resolving relative images inside this document. */
  documentUrl?(id: DocumentId): string
  /** 在已加载的课程结构里搜标题。实现不得为此发起额外网络请求（见下） */
  searchTitles(query: string, signal?: AbortSignal): Promise<TitleHit[]>
}

// ---- 阅读状态事件（阅读器只发事件，不管存哪；docs/03 §9.3）----

/** 阅读器只发这两件事。「存哪、要不要存」全由调用方决定 */
export type ReadingEvents = {
  onChapterEnter?: (documentId: DocumentId, chapterIndex: number) => void
  onScrollAnchor?: (documentId: DocumentId, chapterIndex: number, blockId: string) => void
}

// ---- 导航原语（docs/03 §9.4）----

/**
 * 大纲节点。**四层**：册标题 → 章(H2) → 节(H3) → 小节(H4)。
 *
 * 为什么下探到 H4：左栏要的是 Typora 那种可折叠的层级树，
 * 只到 H3 会让长章的节挤成一条平的长列表（实测一册有 39 个 H3）。
 * H4 默认折叠，不主动撑开（docs/03 §9.2）。
 */
export type OutlineNode = {
  title: string
  level: 1 | 2 | 3 | 4
  blockId: string
  children: OutlineNode[]
}

export type BlockContext = {
  chapterIndex: number
  sectionPath: string[]
}

export type ReaderApi = {
  scrollToBlock(blockId: string): void
  getBlockContext(blockId: string): BlockContext | undefined
  getOutline(): OutlineNode[]
  getPosition(): { chapterIndex: number; blockId: string }
}

/** 阅读器对外接受的插槽（普通 React props；插槽注册表住在 app 层，docs/03 §0.1.1） */
export type ReaderSlots = {
  selectionActionsSlot?: ReactNode
  toolbarSlot?: ReactNode
  sidePanel?: ReactNode
}
