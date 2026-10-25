import type { CourseCatalogCategory, CourseSummary, DocumentSummary, OrganizationMember } from '../types.ts'

/** Only navigation paths are derived; card IDs and the original subject paths are preserved. */
export function sourceCatalog(courses: CourseSummary[]) {
  const categories: CourseCatalogCategory[] = []
  const sources = new Map<string, string>()
  const collections = new Map<string, string>()
  const navigationCourses = courses.map(course => {
    const org = course.organization
    const sourceKey = JSON.stringify(org?.source_id ?? null)
    let sourceId = sources.get(sourceKey)
    if (!sourceId) {
      sourceId = `source${sources.size}`
      sources.set(sourceKey, sourceId)
      categories.push({ id: sourceId, name: org?.source_name || '来源未知' })
    }
    const collectionKey = JSON.stringify([sourceKey, org?.collection_id ?? null])
    let collectionId = collections.get(collectionKey)
    if (!collectionId) {
      collectionId = `${sourceId}.collection${collections.size}`
      collections.set(collectionKey, collectionId)
      categories.push({ id: collectionId, name: org?.collection_title || '合集 / 系列未知' })
    }
    return { ...course, categoryPaths: [collectionId] }
  })
  return { categories, courses: navigationCourses }
}

export function acceptedDelivery(course: CourseSummary): boolean {
  return course.source_role === 'owned_publish' && !!course.scope_description &&
    ['reviewed', 'reviewed_with_limits'].includes(course.review_summary?.decision ?? '')
}

export function cardStats(courses: CourseSummary[]) {
  const unique = [...new Map(courses.map(course => [course.id, course])).values()]
  return {
    content_cards: unique.length,
    registered_courses: unique.filter(course => course.organization?.registered_course === true).length,
    registration_unknown: unique.filter(course => typeof course.organization?.registered_course !== 'boolean').length,
    accepted_deliveries: unique.filter(acceptedDelivery).length,
  }
}

export function registrationLabel(stats: ReturnType<typeof cardStats>): string {
  if (!stats.registration_unknown) return String(stats.registered_courses)
  if (!stats.registered_courses) return '未知'
  return `${stats.registered_courses}（另 ${stats.registration_unknown} 张登记未知）`
}

export type LibraryBucket = 'accepted' | 'registered' | 'learning' | 'source_only' | 'unknown'

/**
 * A card's navigation role is derived from evidence already present in the
 * manifest.  It never changes the card identity or promotes a card to a
 * course/accepted delivery.
 */
export function libraryBucket(course: CourseSummary): LibraryBucket {
  if (acceptedDelivery(course)) return 'accepted'
  if (course.organization?.registered_course === true) return 'registered'
  if (course.organization?.registered_course !== false) return 'unknown'
  if (course.volumeCount > 0 || course.noteCount > 0) return 'learning'
  return 'source_only'
}

export function libraryBuckets(courses: CourseSummary[]) {
  const buckets: Record<LibraryBucket, CourseSummary[]> = {
    accepted: [], registered: [], learning: [], source_only: [], unknown: [],
  }
  for (const course of courses) buckets[libraryBucket(course)].push(course)
  return buckets
}

/** A member may refer to other time ranges of the same source. Only current-card documents are products here. */
export function memberDocuments(member: OrganizationMember, documents: DocumentSummary[]): DocumentSummary[] {
  const ids = new Set(member.document_ids)
  return documents.filter(document => ids.has(document.id))
}

export function relatedCards(member: OrganizationMember, cardId: string, courses: CourseSummary[]): CourseSummary[] {
  const ids = new Set(member.related_card_ids)
  ids.delete(cardId)
  return courses.filter(course => ids.has(course.id))
}

export type MemberEntry = { member: OrganizationMember; cards: { card: CourseSummary; member: OrganizationMember }[] }

/** One source member per collection navigation item; each card keeps its own document range. */
export function collectionMembers(courses: CourseSummary[]): MemberEntry[] {
  const entries = new Map<string, MemberEntry>()
  for (const card of courses) {
    for (const member of card.organization?.members ?? []) {
      let entry = entries.get(member.id)
      if (!entry) {
        entry = { member, cards: [] }
        entries.set(member.id, entry)
      }
      const previous = entry.cards.find(item => item.card.id === card.id)
      if (previous) {
        previous.member = { ...previous.member,
          document_ids: [...new Set([...previous.member.document_ids, ...member.document_ids])],
          related_card_ids: [...new Set([...previous.member.related_card_ids, ...member.related_card_ids])],
        }
      } else entry.cards.push({ card, member })
    }
  }
  return [...entries.values()]
}
