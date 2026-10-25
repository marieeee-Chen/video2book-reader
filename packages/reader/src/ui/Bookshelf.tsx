/**
 * 书架：多级分类导航、按主分类分组和课程索引。
 *
 * 分类数据来自 catalog/manifest；每门课程在当前视图只出现一次，交叉分类
 * 只用于筛选和导航，不重复累计课程、册数或笔记数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildCategoryTree,
  categoryContainsCourse,
  collectBranchIds,
  countCategory,
  findCategoryAncestors,
  groupCourses,
  isReadableCourse,
  type CategoryNode,
} from '../content/category-tree.ts'
import type { CourseCatalogCategory, CourseSummary, ContentSource, DocumentSummary } from '../types.ts'
import type { OrganizationStats } from '../types.ts'
import { cardStats, libraryBuckets, registrationLabel, sourceCatalog } from '../content/organization.ts'
import { CollectionMembers } from './CollectionMembers.tsx'

export type BookshelfProps = {
  contentSource: ContentSource
  onOpen: (courseId: string) => void
  onOpenDocument?: (courseId: string, document: DocumentSummary) => void
  /** 各课的已读册数（由调用方提供；阅读器本身不存任何东西） */
  progress?: Record<string, number>
  /** 只看可读（有册或有笔记）的初值；仅挂载时读取，变更经 onReadableOnlyChange 通知宿主 */
  defaultReadableOnly?: boolean
  onReadableOnlyChange?: (next: boolean) => void
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; courses: CourseSummary[]; categories: CourseCatalogCategory[]; organizationStats?: OrganizationStats }
  | { phase: 'error'; message: string }

const ALL_COURSES_ID = '__all_courses__'

function treeDomId(categoryId: string): string {
  return `shelf-tree-${categoryId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function Bookshelf({
  contentSource,
  onOpen,
  onOpenDocument,
  progress = {},
  defaultReadableOnly = true,
  onReadableOnlyChange,
}: BookshelfProps) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [view, setView] = useState<'courses' | 'topics' | 'source' | 'subject'>('courses')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [readableOnly, setReadableOnly] = useState(defaultReadableOnly)
  const initializedTree = useRef(false)
  const navRef = useRef<HTMLElement>(null)
  const mobileToggleRef = useRef<HTMLButtonElement>(null)

  const updateReadableOnly = useCallback(
    (next: boolean) => {
      setReadableOnly(next)
      onReadableOnlyChange?.(next)
    },
    [onReadableOnlyChange],
  )

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    Promise.all([contentSource.listCourses(), contentSource.listCategories().catch(() => []), contentSource.organizationStats?.().catch(() => undefined)])
      .then(([courses, categories, organizationStats]) => {
        if (!cancelled) setState({ phase: 'ready', courses, categories, organizationStats })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ phase: 'error', message: e.message })
      })
    return () => {
      cancelled = true
    }
  }, [contentSource])

  const allCourses = state.phase === 'ready' ? state.courses : []
  const buckets = useMemo(() => libraryBuckets(allCourses), [allCourses])
  const organizationAvailable = buckets.unknown.length !== allCourses.length
  const effectiveView = organizationAvailable ? view : 'subject'
  const baseCourses = effectiveView === 'courses'
    ? [...buckets.accepted, ...buckets.registered]
    : effectiveView === 'topics'
      ? buckets.learning
      : allCourses
  const sources = useMemo(() => sourceCatalog(baseCourses), [baseCourses])
  const courses = effectiveView === 'source' || effectiveView === 'topics' ? sources.courses : baseCourses
  const categories = effectiveView === 'source' || effectiveView === 'topics'
    ? sources.categories
    : state.phase === 'ready' ? state.categories : []
  const tree = useMemo(() => buildCategoryTree(categories), [categories])
  const branchIds = useMemo(() => collectBranchIds(tree), [tree])
  // 分类内全量（侧栏同口径的 Y）与可读过滤后的可见集（列表口径的 X）
  const inCategory = useMemo(
    () => courses.filter((course) => categoryContainsCourse(course, selectedCategoryId)),
    [courses, selectedCategoryId],
  )
  // “只看可读”只筛选全量索引；正式课程按登记口径完整呈现，学习专题本身已是可读集合。
  const filterReadable = readableOnly && (effectiveView === 'source' || effectiveView === 'subject')
  const visibleCourses = useMemo(
    () => inCategory.filter((course) => !filterReadable || isReadableCourse(course)),
    [filterReadable, inCategory],
  )
  const groups = useMemo(
    () => groupCourses(visibleCourses, selectedCategoryId, categories),
    [visibleCourses, selectedCategoryId, categories],
  )
  const courseOrder = useMemo(() => new Map(courses.map((course, index) => [course.id, index])), [courses])
  const selectedAncestors = useMemo(
    () => (selectedCategoryId ? findCategoryAncestors(tree, selectedCategoryId) : []),
    [tree, selectedCategoryId],
  )
  const activePathIds = useMemo(
    () => new Set(selectedCategoryId ? [...selectedAncestors, selectedCategoryId] : []),
    [selectedAncestors, selectedCategoryId],
  )

  useEffect(() => {
    if (state.phase !== 'ready') return
    const valid = new Set(branchIds)
    setCollapsedIds((previous) => {
      if (!initializedTree.current) {
        initializedTree.current = true
        return new Set(branchIds.filter((id) => id.includes('.')))
      }
      return new Set([...previous].filter((id) => valid.has(id)))
    })
  }, [branchIds, state.phase])

  const selectCategory = useCallback((categoryId: string | null) => {
    setSelectedCategoryId(categoryId)
    if (categoryId) {
      const ancestors = findCategoryAncestors(tree, categoryId)
      setCollapsedIds((previous) => {
        const next = new Set(previous)
        ancestors.forEach((ancestor) => next.delete(ancestor))
        return next
      })
    }
    setMobileNavOpen(false)
  }, [tree])

  const toggleCategory = useCallback((categoryId: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }, [])

  const expandAll = useCallback(() => setCollapsedIds(new Set()), [])
  const collapseAll = useCallback(() => setCollapsedIds(new Set(branchIds)), [branchIds])

  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, categoryId: string, hasChildren: boolean) => {
      const visibleButtons = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('[data-category-id]') ?? []).filter(
        (button) => button.offsetParent !== null,
      )
      const index = visibleButtons.findIndex((button) => button.dataset.categoryId === categoryId)
      const focusAt = (nextIndex: number) => {
        const button = visibleButtons[(nextIndex + visibleButtons.length) % visibleButtons.length]
        button?.focus()
      }
      const focusCategory = (targetId: string) => visibleButtons.find((button) => button.dataset.categoryId === targetId)?.focus()

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        focusAt(index + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        focusAt(index - 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusAt(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusAt(visibleButtons.length - 1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        const node = findNode(tree, categoryId)
        if (hasChildren && collapsedIds.has(categoryId)) toggleCategory(categoryId)
        else if (node?.children[0]) focusCategory(node.children[0].id)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (hasChildren && !collapsedIds.has(categoryId)) toggleCategory(categoryId)
        else {
          const parent = findCategoryAncestors(tree, categoryId).at(-1)
          if (parent) focusCategory(parent)
        }
      }
    },
    [collapsedIds, selectedAncestors, toggleCategory, tree],
  )

  if (state.phase === 'loading') return <div className="reader-status">正在读取书架…</div>
  if (state.phase === 'error') {
    return (
      <div className="reader-status reader-status-error">
        <p>书架还没出来。</p>
        <p className="detail">{state.message}</p>
      </div>
    )
  }
  if (state.courses.length === 0) {
    return <div className="reader-status">还没有内容。</div>
  }

  const fullStats = cardStats(allCourses)
  const totalStats = state.organizationStats ?? fullStats
  const visibleStats = cardStats(visibleCourses)
  const scopeStats = cardStats(inCategory)
  const rootName = effectiveView === 'courses' ? '正式课程'
    : effectiveView === 'topics' ? '学习专题'
      : effectiveView === 'source' ? '全部来源内容' : '全部内容卡片'
  const selectedName = selectedCategoryId
    ? categories.find((category) => category.id === selectedCategoryId)?.name ?? selectedCategoryId
    : rootName
  const selectedPath = selectedCategoryId
    ? [...selectedAncestors, selectedCategoryId].map((id) => categories.find((category) => category.id === id)?.name ?? id)
    : []

  return (
    <div className="shelf">
      <div className="shelf-view-switch" role="group" aria-label="书架导航视图">
        {(organizationAvailable ? ['courses', 'topics', 'source', 'subject'] as const : ['subject'] as const).map(mode => (
          <button type="button" key={mode} aria-pressed={effectiveView === mode} onClick={() => {
            setView(mode)
            setSelectedCategoryId(null)
            initializedTree.current = false
            setCollapsedIds(new Set())
            setMobileNavOpen(false)
          }}>{mode === 'courses' ? '正式课程' : mode === 'topics' ? '学习专题' : mode === 'source' ? '来源档案' : '学科索引'}</button>
        ))}
      </div>
      <div className={`shelf-layout${categories.length === 0 ? ' shelf-no-nav' : ''}${navCollapsed ? ' shelf-nav-collapsed' : ''}`}>
        {categories.length > 0 && (
          <>
            <button
              ref={mobileToggleRef}
              type="button"
              className="shelf-mobile-nav-toggle"
              aria-expanded={mobileNavOpen}
              aria-controls="shelf-category-nav"
              onClick={() => {
                if (navCollapsed) setNavCollapsed(false)
                setMobileNavOpen((open) => !open)
              }}
            >
              <span>{effectiveView === 'source' || effectiveView === 'topics' ? '来源' : '学科'} · {selectedName}</span>
              <span>{visibleCourses.length} 张</span>
              <span aria-hidden="true">{mobileNavOpen ? '▴' : '▾'}</span>
            </button>
            <CategoryNav
              ref={navRef}
              id="shelf-category-nav"
              courses={courses}
              label={effectiveView === 'source' || effectiveView === 'topics' ? '来源 / 合集导航' : '学科分类导航'}
              tree={tree}
              hasBranches={branchIds.length > 0}
              collapsedIds={collapsedIds}
              activePathIds={activePathIds}
              selectedCategoryId={selectedCategoryId}
              onSelect={selectCategory}
              onNodeKeyDown={handleTreeKeyDown}
              onToggle={toggleCategory}
              onExpandAll={expandAll}
              onCollapseAll={collapseAll}
              navCollapsed={navCollapsed}
              onCollapseNav={() => setNavCollapsed((collapsed) => !collapsed)}
              mobileOpen={mobileNavOpen}
              onKeyDownEscape={() => {
                setMobileNavOpen(false)
                mobileToggleRef.current?.focus()
              }}
            />
          </>
        )}

        <main className="shelf-main">
          <header className="shelf-head">
            <div className="shelf-head-main">
              <div className="shelf-head-titles">
                <h1>{selectedName}</h1>
                {selectedPath.length > 0 && (
                  <nav className="shelf-breadcrumb" aria-label="当前分类路径">
                    {selectedPath.map((name, index) => (
                      <span key={`${name}-${index}`}>
                        {index > 0 && <span aria-hidden="true"> / </span>}
                        {name}
                      </span>
                    ))}
                  </nav>
                )}
              </div>
              {(effectiveView === 'source' || effectiveView === 'subject') && (
                <label className="shelf-readable-toggle">
                  <input
                    type="checkbox"
                    checked={readableOnly}
                    onChange={(event) => updateReadableOnly(event.target.checked)}
                  />
                  <span>只看可读</span>
                </label>
              )}
            </div>
            <p className="shelf-stats" aria-live="polite" aria-atomic="true">
              全库：内容卡片 {totalStats.content_cards} · 课程登记 {state.organizationStats ? totalStats.registered_courses : registrationLabel(fullStats)} · 已验收交付 {totalStats.accepted_deliveries}
              <br />
              当前范围（全部）：内容卡片 {scopeStats.content_cards} · 课程登记 {registrationLabel(scopeStats)} · 已验收交付 {scopeStats.accepted_deliveries}
              <br />
              当前显示{filterReadable ? '（只看可读）' : '（全部）'}：内容卡片 {visibleStats.content_cards} · 课程登记 {registrationLabel(visibleStats)} · 已验收交付 {visibleStats.accepted_deliveries}
              {' '}· 侧栏数量包含不可读卡片
            </p>
          </header>

          <div className="shelf-table">
            <div className="shelf-columns" aria-hidden="true">
              <span />
              <span />
              <span>内容卡片</span>
              <span className="shelf-num">正文</span>
              <span className="shelf-num">笔记</span>
              <span className="shelf-num">逐字稿</span>
              <span className="shelf-num">已读</span>
            </div>

            {groups.length === 0 ? (
              inCategory.length > 0 && filterReadable ? (
                <div className="shelf-filter-empty">
                  <p>当前范围暂无可读正文或笔记，可关闭筛选查看全部。</p>
                  <div className="shelf-filter-empty-actions">
                    <button type="button" onClick={() => updateReadableOnly(false)}>关闭筛选</button>
                    <button type="button" onClick={() => selectCategory(null)}>返回全部内容卡片</button>
                  </div>
                </div>
              ) : (
                <div className="shelf-filter-empty">
                  <p>当前范围暂时没有内容卡片。</p>
                  <button type="button" onClick={() => selectCategory(null)}>返回全部内容卡片</button>
                </div>
              )
            ) : (
              groups.map((group) => (
                <section className="shelf-group" key={group.id}>
                  {categories.length > 0 && (
                    <h2 className="shelf-group-head">
                      <span>{effectiveView === 'source' || effectiveView === 'topics' ? `${categories.find(category => category.id === group.id.split('.')[0])?.name} / ` : ''}{group.name}</span>
                      <span className="shelf-group-count">内容卡片 {group.courses.length} · 课程登记 {registrationLabel(cardStats(group.courses))} · 已验收交付 {cardStats(group.courses).accepted_deliveries}</span>
                    </h2>
                  )}
                  {(effectiveView === 'source' || effectiveView === 'topics') && <CollectionMembers cards={group.courses} courses={allCourses} contentSource={contentSource} onOpen={onOpen} onOpenDocument={onOpenDocument} />}
                  <ul className="shelf-list">
                    {group.courses.map((course) => {
                      const displayTitle = course.organization?.display_title || course.title
                      const read = progress[course.id] ?? 0
                      const pct = course.volumeCount > 0 ? Math.min(100, Math.round((read / course.volumeCount) * 100)) : 0
                      const order = (courseOrder.get(course.id) ?? 0) + 1
                      return (
                        <li key={course.id}>
                          <button
                            type="button"
                            className="shelf-open"
                            onClick={() => onOpen(course.id)}
                            aria-label={`${displayTitle}，${course.volumeCount} 份正文，已读 ${read} 份`}
                          >
                            <span className="shelf-rail" aria-hidden="true">
                              <span className="shelf-rail-fill" style={{ height: `${pct}%` }} />
                            </span>
                            <span className="shelf-ord">{String(order).padStart(2, '0')}</span>
                            <span className="shelf-name">
                              <span className="shelf-title">{displayTitle}</span>
                              {course.organization?.source_scope_summary && <span className="shelf-direction">{course.organization.source_scope_summary}</span>}
                              {course.direction && <span className="shelf-direction">{course.direction}</span>}
                              {course.source_role && <span className="shelf-direction">{course.source_role === 'source_archive' ? '存量资料 · 冻结版本' : course.source_role === 'readonly_upstream' ? '上游资料 · 固定版本' : course.delivery_scope === 'full_course' ? '完整交付范围' : '限定交付范围'}</span>}
                            </span>
                            <span className="shelf-num">{course.volumeCount}</span>
                            <span className="shelf-num">{course.noteCount}</span>
                            <span className="shelf-num shelf-dim">{course.subtitleCount || '—'}</span>
                            <span className="shelf-num shelf-dim">
                              {read}/{course.volumeCount}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

function findNode(tree: CategoryNode[], categoryId: string): CategoryNode | undefined {
  for (const node of tree) {
    if (node.id === categoryId) return node
    const found = findNode(node.children, categoryId)
    if (found) return found
  }
  return undefined
}

function CategoryNav({
  ref,
  id,
  courses,
  label,
  tree,
  hasBranches,
  collapsedIds,
  activePathIds,
  selectedCategoryId,
  onSelect,
  onNodeKeyDown,
  onToggle,
  onExpandAll,
  onCollapseAll,
  navCollapsed,
  onCollapseNav,
  mobileOpen,
  onKeyDownEscape,
}: {
  ref: React.RefObject<HTMLElement | null>
  id: string
  courses: CourseSummary[]
  label: string
  tree: CategoryNode[]
  hasBranches: boolean
  collapsedIds: Set<string>
  activePathIds: Set<string>
  selectedCategoryId: string | null
  onSelect: (id: string | null) => void
  onNodeKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, id: string, hasChildren: boolean) => void
  onToggle: (id: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  navCollapsed: boolean
  onCollapseNav: () => void
  mobileOpen: boolean
  onKeyDownEscape: () => void
}) {
  if (navCollapsed) {
    return (
      <aside id={id} className="shelf-nav is-collapsed">
        <button type="button" className="shelf-nav-restore" onClick={onCollapseNav} aria-label="展开分类导航">
          <span aria-hidden="true">☰</span>
          <span>分类</span>
        </button>
      </aside>
    )
  }

  return (
    <aside
      ref={ref}
      id={id}
      className={`shelf-nav${mobileOpen ? ' is-mobile-open' : ''}`}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onKeyDownEscape()
      }}
    >
      <div className="shelf-nav-head">
        <div className="shelf-nav-title">{label}</div>
        {hasBranches && (
          <div className="shelf-nav-actions">
            <button type="button" onClick={onExpandAll} aria-label="展开全部分类">全部展开</button>
            <button type="button" onClick={onCollapseAll} aria-label="收起全部分类">全部收起</button>
            <button type="button" onClick={onCollapseNav} aria-label="收起分类导航">收起</button>
          </div>
        )}
      </div>
      <button
        type="button"
        className={`shelf-nav-item shelf-nav-all${selectedCategoryId === null ? ' is-active' : ''}`}
        data-category-id={ALL_COURSES_ID}
        onClick={() => onSelect(null)}
        onKeyDown={(event) => onNodeKeyDown(event, ALL_COURSES_ID, false)}
        aria-current={selectedCategoryId === null ? 'page' : undefined}
      >
        <span>全部内容卡片</span>
        <span className="shelf-nav-count">{courses.length}</span>
      </button>
      <ul className="shelf-nav-tree" role="tree" aria-label={label}>
        {tree.map((node) => (
          <CategoryBranch
            key={node.id}
            node={node}
            courses={courses}
            collapsedIds={collapsedIds}
            activePathIds={activePathIds}
            selectedCategoryId={selectedCategoryId}
            onSelect={onSelect}
            onToggle={onToggle}
            onKeyDown={onNodeKeyDown}
            depth={0}
          />
        ))}
      </ul>
    </aside>
  )
}

function CategoryBranch({
  node,
  courses,
  collapsedIds,
  activePathIds,
  selectedCategoryId,
  onSelect,
  onToggle,
  onKeyDown,
  depth,
}: {
  node: CategoryNode
  courses: CourseSummary[]
  collapsedIds: Set<string>
  activePathIds: Set<string>
  selectedCategoryId: string | null
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, id: string, hasChildren: boolean) => void
  depth: number
}) {
  const hasChildren = node.children.length > 0
  const expanded = !collapsedIds.has(node.id)
  const selected = selectedCategoryId === node.id
  const inPath = activePathIds.has(node.id)
  return (
    <li role="none">
      <div className={`shelf-tree-row${inPath ? ' is-path' : ''}`} role="treeitem" aria-selected={selected} aria-expanded={hasChildren ? expanded : undefined}>
        {hasChildren ? (
          <button
            type="button"
            className="shelf-tree-toggle"
            aria-label={`${expanded ? '收起' : '展开'}${node.name}`}
            aria-expanded={expanded}
            aria-controls={treeDomId(node.id)}
            tabIndex={-1}
            onClick={() => onToggle(node.id)}
          >
            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="shelf-tree-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className={`shelf-nav-item${selected ? ' is-active' : ''}${inPath ? ' is-path' : ''}`}
          data-category-id={node.id}
          style={{ paddingLeft: `${0.45 + depth * 0.55}rem` }}
          onClick={() => onSelect(node.id)}
          onKeyDown={(event) => onKeyDown(event, node.id, hasChildren)}
          aria-current={selected ? 'page' : undefined}
        >
          <span>{node.name}</span>
          <span className="shelf-nav-count">{countCategory(courses, node.id)}</span>
        </button>
      </div>
      {hasChildren && expanded && (
        <ul id={treeDomId(node.id)} className="shelf-nav-tree" role="group">
          {node.children.map((child) => (
            <CategoryBranch
              key={child.id}
              node={child}
              courses={courses}
              collapsedIds={collapsedIds}
              activePathIds={activePathIds}
              selectedCategoryId={selectedCategoryId}
              onSelect={onSelect}
              onToggle={onToggle}
              onKeyDown={onKeyDown}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
