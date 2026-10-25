import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { acceptedDelivery, cardStats, collectionMembers, libraryBucket, libraryBuckets, memberDocuments, registrationLabel, relatedCards, sourceCatalog } from '../packages/reader/src/content/organization.ts'
import { categoryContainsCourse, countCategory, groupCourses, isReadableCourse } from '../packages/reader/src/content/category-tree.ts'
import { toCourseSummary } from '../packages/reader/src/content/derive.ts'
import { createReleaseSource } from '../packages/reader/src/content/release-source.ts'
import { createGitHubSource } from '../packages/reader/src/content/github-source.ts'

const member = { id: 'BV-shared', title: '视频片段', kind: 'video', cid: 123, document_ids: ['card/textbooks/article.md', 'other/textbooks/article.md', 'missing.md'], related_card_ids: ['card', 'other', 'missing', 'other'], product_types: ['article'], evidence: ['组织清单'] }
const organization = { source_id: 'source.with.dots', source_name: '来源 A', collection_id: 'shared.series', collection_title: '系列', registered_course: true, accepted_delivery: true, members: [member] }
const document = { id: 'card/textbooks/article.md', title: '学习长文', kind: 'volume', originIndex: 1, product_type: 'article', document_uid: 'doc-1', course_uid: 'uid-card', sha256: 'a'.repeat(64), size: 1, source: { repo_id: 'owned', role: 'owned_publish', path: 'textbooks/article.md' } }
const course = { id: 'card', title: '卡片 A', course_uid: 'uid-card', direction: '方向', publishPath: 'card', categoryPaths: ['subject.ai', 'subject.math'], tags: ['标签'], volumes: [document], notes: [], subtitles: [], bytes: 1, organization, source_role: 'owned_publish', delivery_scope: 'slice', scope_description: '一个片段', review_summary: { decision: 'reviewed_with_limits', limitations: ['仅片段'] }, assets: [{ path: 'image.png', bytes: 1, sha256: 'b'.repeat(64) }], external_assets: ['https://example.invalid/external.png'], missing_assets: ['missing.png'] }
const totals = { content_cards: 224, registered_courses: 53, accepted_deliveries: 1 }
const manifest = { manifestVersion: 3, release_id: 'organization-fixture', content_base: 'releases/organization-fixture/courses/', reader_compatibility: { min: 3, max: 3 }, generatedAt: '2026-10-13', categories: [{ id: 'subject', name: '学科' }, { id: 'subject.ai', name: '人工智能' }], stats: { courses: 1, volumes: 1, notes: 0, subtitles: 0, bytes: 1 }, organization_stats: totals, courses: [course] }

test('summary 保留组织、成员扩展、发布审核及附件 metadata', () => {
  const { volumes, notes, subtitles, ...metadata } = course
  assert.deepEqual(toCourseSummary(course), { ...metadata, volumeCount: volumes.length, noteCount: notes.length, subtitleCount: subtitles.length })
})

test('release-source 与静态 manifest 模式提供相同 metadata 和独立全库统计', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async url => {
    requests.push(String(url))
    assert.ok(String(url).endsWith('manifest.json'))
    return new Response(JSON.stringify(manifest))
  }
  try {
    const sources = [createReleaseSource({ manifestUrl: 'https://fixture.invalid/manifest.json' }), createGitHubSource({ owner: 'fixture', repo: 'repo', manifestUrl: 'https://fixture.invalid/static-manifest.json', prefer: 'manifest' })]
    for (const source of sources) {
      const [summary] = await source.listCourses()
      for (const key of ['organization', 'course_uid', 'source_role', 'delivery_scope', 'scope_description', 'review_summary', 'assets', 'external_assets', 'missing_assets', 'categoryPaths', 'tags']) assert.deepEqual(summary[key], course[key], key)
      assert.deepEqual((await source.loadCourse('card')).documents, [document])
      assert.deepEqual((await source.loadCourse('card')).organization, organization)
      assert.deepEqual(await source.organizationStats(), totals)
      assert.deepEqual(await source.listCategories(), manifest.categories)
      // Current visible cards must not replace the authoritative whole-library totals.
      assert.equal(cardStats([summary]).content_cards, 1)
      assert.equal((await source.organizationStats()).content_cards, 224)
    }
    assert.equal(requests.length, 2) // no tree requests or member-driven network expansion
  } finally { globalThis.fetch = originalFetch }
})

test('来源 → 合集分组不碰卡片 ID、进度映射或原学科；不同来源同名系列互不混淆', () => {
  const a = toCourseSummary(course)
  const cards = [a, { ...a, id: 'other', organization: { ...organization, accepted_delivery: false } }, { ...a, id: 'different-source', organization: { ...organization, source_id: 'another', source_name: '来源 B' } }, { ...a, id: 'legacy', organization: undefined }]
  const before = structuredClone(cards)
  const nav = sourceCatalog(cards)
  assert.deepEqual(cards, before)
  assert.deepEqual(nav.courses.map(card => card.id), cards.map(card => card.id))
  const groups = groupCourses(nav.courses, null, nav.categories)
  assert.equal(groups.length, 3)
  assert.equal(new Set(groups.flatMap(group => group.courses.map(card => card.id))).size, cards.length)
  assert.equal(countCategory(nav.courses, 'source0'), 2)
  assert.equal(categoryContainsCourse(nav.courses[2], 'source0'), false)
  const progress = { card: 1, other: 0 }
  assert.equal(groups.flatMap(group => group.courses).find(card => progress[card.id] === 1).id, 'card')
  assert.deepEqual(cards[0].categoryPaths, ['subject.ai', 'subject.math'])
  assert.ok(nav.categories.some(category => category.name === '来源未知'))
})

test('224 张 / 53 登记 / 1 已验收分层去重；过滤后统计只说明当前显示', () => {
  const cards = Array.from({ length: 224 }, (_, i) => ({ ...toCourseSummary(course), id: `card-${i}`, volumeCount: i < 7 ? 1 : 0, noteCount: 0, organization: { ...organization, registered_course: i < 53, accepted_delivery: i === 0 }, review_summary: { decision: i === 0 ? 'reviewed' : 'unreviewed', limitations: [] } }))
  assert.deepEqual(cardStats(cards), { ...totals, registration_unknown: 0 })
  assert.deepEqual(cardStats([...cards, cards[0]]), cardStats(cards))
  assert.deepEqual(cardStats(cards.filter(isReadableCourse)), { content_cards: 7, registered_courses: 7, accepted_deliveries: 1, registration_unknown: 0 })
  assert.deepEqual(cardStats(cards), { ...totals, registration_unknown: 0 })
})

test('默认课程、学习专题和来源档案分层，不改变卡片身份或总数', () => {
  const base = toCourseSummary(course)
  const accepted = { ...base, id: 'accepted' }
  const registered = { ...base, id: 'registered', source_role: 'source_archive', review_summary: { decision: 'unreviewed', limitations: [] }, organization: { ...organization, accepted_delivery: false } }
  const learning = { ...registered, id: 'learning', organization: { ...organization, registered_course: false, accepted_delivery: false } }
  const sourceOnly = { ...learning, id: 'source-only', volumeCount: 0, noteCount: 0 }
  const unknown = { ...learning, id: 'unknown', organization: undefined }
  assert.equal(libraryBucket(accepted), 'accepted')
  assert.equal(libraryBucket(registered), 'registered')
  assert.equal(libraryBucket(learning), 'learning')
  assert.equal(libraryBucket(sourceOnly), 'source_only')
  assert.equal(libraryBucket(unknown), 'unknown')
  const buckets = libraryBuckets([accepted, registered, learning, sourceOnly, unknown])
  assert.deepEqual(Object.fromEntries(Object.entries(buckets).map(([key, cards]) => [key, cards.map(card => card.id)])), {
    accepted: ['accepted'], registered: ['registered'], learning: ['learning'], source_only: ['source-only'], unknown: ['unknown'],
  })
})

test('仅自有发布 reviewed/reviewed_with_limits 算验收；导航声明不授予批准，登记缺失为未知', () => {
  const base = { ...toCourseSummary(course), organization: undefined }
  for (const role of ['source_archive', 'readonly_upstream', 'owned_publish', undefined]) {
    for (const decision of ['reviewed', 'reviewed_with_limits', 'unreviewed', 'pending', undefined]) {
      assert.equal(acceptedDelivery({ ...base, source_role: role, review_summary: decision ? { decision, limitations: [] } : undefined }), role === 'owned_publish' && ['reviewed', 'reviewed_with_limits'].includes(decision))
    }
  }
  assert.equal(acceptedDelivery({ ...base, source_role: 'source_archive', organization }), false)
  assert.equal(acceptedDelivery({ ...base, organization: { ...organization, accepted_delivery: false } }), true) // owned reviewed_with_limits fallback
  assert.equal(registrationLabel(cardStats([base])), '未知')
  assert.equal(registrationLabel(cardStats([{ ...base, organization: { ...organization, registered_course: false } }])), '0')
  assert.match(registrationLabel(cardStats([base, toCourseSummary({ ...course, id: 'known' })])), /^1.*未知/)
})

test('成员只关联当前卡片文档；同 BV 不同时段保留各自卡片作为同源入口', () => {
  const foreign = { ...document, id: 'other/textbooks/article.md' }
  const extra = { ...document, id: 'card/textbooks/unrelated.md' }
  assert.deepEqual(memberDocuments(member, [document, extra]), [document])
  assert.deepEqual(memberDocuments({ ...member, document_ids: [foreign.id] }, [document, extra]), [])
  const cards = [toCourseSummary(course), { ...toCourseSummary(course), id: 'other', title: '同 BV 的另一个时段', organization: { ...organization, members: [{ ...member, cid: 456 }] } }]
  assert.deepEqual(relatedCards(member, 'card', cards).map(card => card.id), ['other'])
  assert.equal(cards.length, 2)
  const members = collectionMembers(cards)
  assert.equal(members.length, 1)
  assert.deepEqual(members[0].cards.map(item => item.card.id), ['card', 'other'])
  assert.equal(members[0].cards[1].member.cid, 456)
  assert.equal(cards[0].organization.members[0].cid, 123)
})

async function productsRenderer(run) {
  // SSR does not run effects. Inject the loaded fixture into the initial shelf state;
  // all view/group/statistics JSX and child components remain the production code.
  const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, plugins: [{
    name: 'shelf-ready-fixture', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/ui/Bookshelf.tsx')) return
      const initial = "useState<State>({ phase: 'loading' })"
      assert.ok(code.includes(initial), '书架加载初值变化时必须更新渲染夹具')
      return code.replace(initial, 'useState<State>(contentSource.__testShelfState)')
    },
  }] })
  try {
    const { MemberProducts } = await server.ssrLoadModule('/packages/reader/src/ui/CollectionMembers.tsx')
    const { Bookshelf } = await server.ssrLoadModule('/packages/reader/src/ui/Bookshelf.tsx')
    await run(MemberProducts, Bookshelf)
  } finally { await server.close() }
}

test('合集成员渲染只出现一次；各卡成品按钮通过原卡片 ID 打开，未关联文档不泄漏', async () => {
  const a = toCourseSummary(course)
  const b = { ...a, id: 'other', title: '同 BV 不同时段', organization: { ...organization, members: [{ ...member, document_ids: ['other/textbooks/article.md'], related_card_ids: ['third'] }] } }
  const third = { ...a, id: 'third', title: '另外的同源入口' }
  const foreign = { ...document, id: 'other/textbooks/article.md', title: '另一个时段的成品' }
  const unlinked = { ...document, id: 'card/textbooks/unlinked.md', title: '不应出现的文档' }
  await productsRenderer(MemberProducts => {
    const opened = []
    const props = { members: collectionMembers([a, b]), courses: [a, b, third], documentsByCard: { card: [document, unlinked], other: [foreign] }, onOpen: id => opened.push(id) }
    const html = renderToStaticMarkup(createElement(MemberProducts, props))
    assert.equal((html.match(/data-member-id=/g) ?? []).length, 1)
    assert.equal((html.match(/data-document-id=/g) ?? []).length, 2)
    assert.ok(!html.includes(unlinked.title))
    assert.ok(html.includes('同源入口'))
    assert.ok(html.includes('覆盖范围见各卡片说明'))
    assert.ok(!/重复字节|已合并|独立课程/.test(html))
    const walk = (node, cardId) => {
      if (Array.isArray(node)) return node.forEach(child => walk(child, cardId))
      if (!node || typeof node !== 'object') return
      const current = node.props?.['data-card-id'] ?? cardId
      if (node.type === 'button' && current) {
        node.props.onClick()
        assert.equal(opened.at(-1), current)
      }
      walk(node.props?.children, current)
    }
    walk(MemberProducts(props))
    assert.deepEqual(opened, ['card', 'card', 'other', 'other'])
    const selectedDocuments = []
    const directProps = { ...props, onOpenDocument: (cardId, doc) => selectedDocuments.push([cardId, doc.id]) }
    const clickProducts = node => {
      if (Array.isArray(node)) return node.forEach(clickProducts)
      if (!node || typeof node !== 'object') return
      if (node.props?.['data-document-id']) node.props.children.props.onClick()
      clickProducts(node.props?.children)
    }
    clickProducts(MemberProducts(directProps))
    assert.deepEqual(selectedDocuments, [['card', document.id], ['other', foreign.id]])
  })
})

test('旧 manifest 不含组织统计时兼容，不编造课程登记', async () => {
  const legacy = { ...manifest, organization_stats: undefined, courses: [{ ...course, organization: undefined }] }
  const source = createReleaseSource({ manifestUrl: 'https://fixture.invalid/manifest.json', fetch: async () => new Response(JSON.stringify(legacy)) })
  assert.equal(await source.organizationStats(), undefined)
  assert.equal(registrationLabel(cardStats(await source.listCourses())), '未知')
})

test('更高档位来源显示受限与用户保留决定，不隐藏既有归档或授予验收', async () => {
  const restricted = { ...member, kind: 'article', source_availability: {
    status: 'access_restricted', disposition: 'retained_restricted_by_user',
    unlock_labels: ['238元充电'], user_reported_unlocked_tier_cny: 128,
  } }
  const card = { ...toCourseSummary(course), source_role: 'source_archive',
    organization: { ...organization, members: [restricted] } }
  await productsRenderer(MemberProducts => {
    const html = renderToStaticMarkup(createElement(MemberProducts, {
      members: collectionMembers([card]), courses: [card],
      documentsByCard: { card: [document] }, onOpen() {},
    }))
    assert.ok(html.includes('238元充电'))
    assert.ok(html.includes('按你的要求保留更高档位限制'))
    assert.ok(html.includes('已有归档或摘要不代表全文交付'))
    assert.ok(html.includes('data-document-id='))
    assert.equal(acceptedDelivery(card), false)
  })
})

// Optional real preview: node scripts/check-organization.mjs /absolute/path/manifest.preview.json
if (process.argv[2]) test('真实组织预览：224 卡 / 53 登记 / 1 验收，120 仅导航容器；逐合集验证成员渲染', async () => {
  const preview = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  assert.deepEqual(preview.organization_stats, totals)
  const cards = preview.courses.map(toCourseSummary)
  assert.deepEqual(cardStats(cards), { ...totals, registration_unknown: 0 })
  const nav = sourceCatalog(cards)
  const groups = groupCourses(nav.courses, null, nav.categories)
  assert.equal(groups.length, 120)
  assert.deepEqual(groups.flatMap(group => group.courses.map(card => card.id)).sort(), cards.map(card => card.id).sort())
  const source = createReleaseSource({ manifestUrl: 'https://fixture.invalid/manifest.json', fetch: async () => new Response(JSON.stringify(preview)) })
  assert.deepEqual(await source.listCourses(), cards)
  assert.deepEqual(await source.listCategories(), preview.categories)
  assert.deepEqual(await source.organizationStats(), totals)
  const documentsByCard = Object.fromEntries(preview.courses.map(card => [card.id, [...card.volumes, ...card.notes, ...card.subtitles]]))
  let deduplicatedCollections = 0
  await productsRenderer((MemberProducts, Bookshelf) => {
    const contentSource = { ...source, __testShelfState: { phase: 'ready', courses: cards, categories: preview.categories, organizationStats: preview.organization_stats } }
    for (const readableOnly of [false, true]) {
      const shelf = renderToStaticMarkup(createElement(Bookshelf, { contentSource, onOpen() {}, defaultReadableOnly: readableOnly, progress: { 'hard-brain-p01': 1 } }))
      assert.match(shelf, /正式课程/)
      assert.match(shelf, /学习专题/)
      assert.match(shelf, /来源档案/)
      assert.match(shelf, /学科索引/)
      assert.match(shelf, /全库：内容卡片 224 · 课程登记 53 · 已验收交付 1/)
      const formal = cards.filter(card => ['accepted', 'registered'].includes(libraryBucket(card)))
      assert.equal((shelf.match(/class="shelf-open"/g) ?? []).length, formal.length)
      assert.equal((shelf.match(/class="shelf-group"/g) ?? []).length, groupCourses(formal, null, preview.categories).length)
      assert.ok(!shelf.includes('只看可读'))
      assert.ok(!/独立课程|册模块全书/.test(shelf))
    }
    for (const group of groups) {
      const members = collectionMembers(group.courses)
      const rawCount = group.courses.reduce((n, card) => n + card.organization.members.length, 0)
      if (members.length < rawCount) deduplicatedCollections++
      const html = renderToStaticMarkup(createElement(MemberProducts, { members, courses: cards, documentsByCard, onOpen() {} }))
      assert.equal((html.match(/data-member-id=/g) ?? []).length, members.length)
      const expectedDocuments = members.reduce((n, entry) => n + entry.cards.reduce((count, item) => count + memberDocuments(item.member, documentsByCard[item.card.id]).length, 0), 0)
      assert.equal((html.match(/data-document-id=/g) ?? []).length, expectedDocuments)
      assert.ok(!/重复字节|已合并|独立课程/.test(html))
    }
  })
  assert.ok(deduplicatedCollections > 0)
  console.log(`真实预览验证：${cards.length} 张卡片，${groups.length} 个导航容器，${deduplicatedCollections} 个合集含共享成员`)
})
