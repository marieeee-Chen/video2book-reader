import { useEffect, useState } from 'react'
import { collectionMembers, memberDocuments, relatedCards, type MemberEntry } from '../content/organization.ts'
import type { ContentSource, CourseSummary, DocumentSummary } from '../types.ts'

const kindLabels = { video: '视频', article: '文章', unknown: '类型未知' }
const productLabels: Record<string, string> = { article: '精读长文', textbook: '学习教材', note: '笔记', transcript: '来源稿', mindmap: '思维导图', asset: '附件', legacy_unknown: '正文（类型待核）' }

export function CollectionMembers({ cards, courses, contentSource, onOpen, onOpenDocument }: {
  cards: CourseSummary[]
  courses: CourseSummary[]
  contentSource: ContentSource
  onOpen: (cardId: string) => void
  onOpenDocument?: (cardId: string, document: DocumentSummary) => void
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ documents?: Record<string, DocumentSummary[]>; error?: string }>({})
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({})
    Promise.all(cards.map(async card => {
      const detail = await contentSource.loadCourse(card.id)
      return [card.id, detail.documents] as const
    })).then(details => {
      if (!cancelled) setState({ documents: Object.fromEntries(details) })
    }).catch((error: Error) => {
      if (!cancelled) setState({ error: error.message })
    })
    return () => { cancelled = true }
  }, [open, cards, contentSource])

  const members = collectionMembers(cards)
  if (!members.length) return <p className="shelf-members-empty">来源成员信息未知</p>
  return (
    <details className="shelf-members" onToggle={event => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
    }}>
      <summary>来源成员 → 学习成品（{members.length}）</summary>
      {open && (
        <div>
          {state.error && <p role="alert">成品列表加载失败：{state.error}。收起后展开可重试。</p>}
          {!state.documents && !state.error && <p role="status">正在读取当前卡片成品…</p>}
          <MemberProducts members={members} courses={courses} documentsByCard={state.documents} onOpen={onOpen} onOpenDocument={onOpenDocument} />
        </div>
      )}
    </details>
  )
}

export function MemberProducts({ members, courses, documentsByCard, onOpen, onOpenDocument }: {
  members: MemberEntry[]
  courses: CourseSummary[]
  documentsByCard?: Record<string, DocumentSummary[]>
  onOpen: (cardId: string) => void
  onOpenDocument?: (cardId: string, document: DocumentSummary) => void
}) {
  return members.map(entry => {
    const member = entry.member
    const currentIds = new Set(entry.cards.map(item => item.card.id))
    const links = [...new Map(entry.cards.flatMap(item => relatedCards(item.member, item.card.id, courses)).filter(card => !currentIds.has(card.id)).map(card => [card.id, card])).values()]
    return (
      <details key={member.id} className="shelf-member" data-member-id={member.id}>
        <summary>{kindLabels[member.kind]} · {member.title}</summary>
        {entry.cards.length > 1 && <p>同源卡片的不同成品入口（覆盖范围见各卡片说明）</p>}
        {entry.cards.map(({ card, member: cardMember }) => {
          const documents = memberDocuments(cardMember, documentsByCard?.[card.id] ?? [])
          const availability = cardMember.source_availability
          return <div key={card.id} className="shelf-member-card" data-card-id={card.id}>
            <button type="button" onClick={() => onOpen(card.id)}>{card.organization?.display_title || card.title}</button>
            {availability?.status === 'access_restricted' && <p className="shelf-source-restriction">
              来源全文受限{availability.unlock_labels?.length ? `（页面提示：${availability.unlock_labels.join('、')}）` : ''}。
              {availability.disposition === 'retained_restricted_by_user'
                ? '按你的要求保留更高档位限制，不购买、不猜补。'
                : '当前登录态未取得授权全文。'}
              已有归档或摘要不代表全文交付。
            </p>}
            {documentsByCard && (documents.length ? (
              <ul>{documents.map(document => <li key={document.id} data-document-id={document.id}>
                <button type="button" onClick={() => onOpenDocument ? onOpenDocument(card.id, document) : onOpen(card.id)}>{productLabels[document.product_type ?? ''] ?? (document.kind === 'volume' ? '正文（类型待核）' : document.kind === 'note' ? '笔记' : '来源稿')} · {document.title}</button>
              </li>)}</ul>
            ) : <p>当前卡片无关联学习成品</p>)}
          </div>
        })}
        {links.length > 0 && <div className="shelf-related">同源入口：{links.map(card => (
          <button type="button" key={card.id} onClick={() => onOpen(card.id)}>{card.title}</button>
        ))}</div>}
      </details>
    )
  })
}
