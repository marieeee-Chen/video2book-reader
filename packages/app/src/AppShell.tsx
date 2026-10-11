import { Component, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Agent, createThread, type Thread, type Turn, type Item } from '../../agent/src/index.ts'
import type { PluginRuntime, Registry, SlotContribution } from '../../plugin/src/index.ts'
import type { ContentSource, DocumentInfo, ReaderApi } from '../../reader/src/types.ts'
import { ReadingApp } from './reading/ReadingApp.tsx'
import './reading/app.css'
import './shell.css'
import './ui/theme.css'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
export type CustomModel = { id: string; endpoint: string; model: string; protocol: 'openai-chat-completions' | 'anthropic-messages' | 'google-native'; options?: Record<string, unknown> }
export type ShellProps = { runtime: PluginRuntime; source: ContentSource; setModel: (model: CustomModel, key: string) => Promise<void>; threadForContent?: (info: DocumentInfo, chapter: number, modelRef?: string, scope?: 'chapter' | 'volume') => Promise<Thread>; onCurrent?: (value: { info?: DocumentInfo; chapterIndex: number; thread?: Thread; api: ReaderApi | null }) => void; quote?: Item['attachments']; clearQuote?: () => void; profileChange?: (full: boolean) => Promise<void>; checkForUpdates?: () => Promise<string>; chooseLocalContent?: () => Promise<void> }
class SlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.error('扩展界面加载失败') }
  render() { return this.state.failed ? null : this.props.children }
}
function useRegistry<T extends { id: string }>(registry: Registry<T>): T[] {
  const [, refresh] = useState(0)
  useEffect(() => registry.subscribe(() => refresh(n => n + 1)), [registry])
  return registry.list()
}
function SlotHost({ registry, slot }: { registry: Registry<SlotContribution>; slot: string }) {
  const contributions = useRegistry(registry).filter(c => c.slot === slot).sort((a, b) => a.order - b.order)
  return <>{contributions.map(c => <SlotBoundary key={c.id}><c.component /></SlotBoundary>)}</>
}
function ModelSettings({ save }: { save: ShellProps['setModel'] }) {
  const [protocol, setProtocol] = useState<CustomModel['protocol']>('openai-chat-completions')
  const [endpoint, setEndpoint] = useState(''), [model, setName] = useState(''), [key, setKey] = useState(''), [status, setStatus] = useState('')
  const [optionsText, setOptionsText] = useState('')
  return <form className="model-settings" onSubmit={e => {
    e.preventDefault()
    let options: Record<string, unknown> | undefined
    try {
      if (optionsText.trim()) {
        const parsed: unknown = JSON.parse(optionsText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
        options = parsed as Record<string, unknown>
        if (Object.keys(options).some(name => /^(api[_-]?key|authorization|token|secret|password)$/i.test(name))) throw new Error('credential options forbidden')
      }
    } catch { setStatus('模型参数须为 JSON 对象；密钥请填在独立密钥栏。'); return }
    setStatus('保存中…')
    void save({ id: 'custom', endpoint, model, protocol, ...(options ? { options } : {}) }, key).then(() => { setKey(''); setStatus('已保存。可以回到阅读页提问。') }).catch(() => setStatus('保存失败，请检查端点和安全存储状态。'))
  }}>
    <h2>自定义模型</h2><p>模型可选。端点与模型名保存在本机，密钥单独保存。</p>
    <label>协议<select value={protocol} onChange={e => setProtocol(e.target.value as CustomModel['protocol'])}><option value="openai-chat-completions">Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-native">Google Native</option></select></label>
    <label>端点<Input value={endpoint} onChange={e => setEndpoint(e.target.value)} type="url" required placeholder="输入自己的服务地址" /></label>
    <label>模型<Input value={model} onChange={e => setName(e.target.value)} required /></label>
    <label>密钥<Input value={key} onChange={e => setKey(e.target.value)} type="password" autoComplete="off" /></label>
    <label>可选模型参数（JSON）<textarea value={optionsText} onChange={e => setOptionsText(e.target.value)} rows={3} placeholder={'例如 {"reasoning_effort":"low"}'} /></label>
    <Button type="submit">保存</Button><p role="status">{status}</p>
  </form>
}
export function AppShell(props: ShellProps) {
  const { runtime, source, threadForContent, onCurrent, quote, clearQuote, profileChange } = props
  const registry = runtime.registries, ports = runtime.ports
  const agent = useRef(new Agent(registry)), api = useRef<ReaderApi | null>(null), abort = useRef<AbortController | undefined>(undefined)
  const [info, setInfo] = useState<DocumentInfo>(), [chapter, setChapter] = useState(0), [thread, setThread] = useState<Thread>()
  const [open, setOpen] = useState(false), [view, setView] = useState('reading'), [input, setInput] = useState(''), [busy, setBusy] = useState(false), [turn, setTurn] = useState<Turn>()
  const busyRef = useRef(false)
  const guardedModelSave = useCallback<ShellProps['setModel']>((model, key) => {
    if (busyRef.current) return Promise.reject(new Error('请先停止当前回答再修改模型'))
    return props.setModel(model, key)
  }, [props.setModel])
  const [, redraw] = useState(0), [error, setError] = useState(''), [full, setFull] = useState(true), [scope, setScope] = useState<'chapter' | 'volume'>('chapter')
  const [followUp, setFollowUp] = useState<{ threadId: string; text: string; label: string }>()
  const providers = useRegistry(registry.providers), prompts = useRegistry(registry.prompts), views = useRegistry(registry.views)
  const providerId = providers[0]?.id
  const capability = useRef('')
  useEffect(() => {
    const dispose = registry.views.register({ id: 'settings', title: '设置', component: (() => <ModelSettings save={guardedModelSave} />) as ComponentType })
    const status = registry.slots.register({ id: 'release-status', slot: 'toolbar', order: 0, component: () => <small>固定内容版本</small> })
    return () => { dispose(); status() }
  }, [registry, guardedModelSave])
  useEffect(() => {
    let cancelled = false
    abort.current?.abort()
    setThread(undefined); clearQuote?.()
    const bindThread = full ? threadForContent : undefined
    if (info && bindThread && scope === 'chapter' && chapter === 0) { setError('册首与导读不参与章会话，请进入正文或选择本册范围。'); return () => { cancelled = true } }
    if (info && bindThread) void bindThread(info, chapter, providerId, scope).then(t => { if (!cancelled) { setThread(t); setError('') } }).catch(e => { if (!cancelled) setError(String(e)) })
    else { const t = createThread({ kind: 'session', key: 'default' }, {}, providerId); setThread(t); setError('') }
    return () => { cancelled = true }
  }, [info, chapter, providerId, threadForContent, scope, clearQuote, full])
  useEffect(() => {
    onCurrent?.({ info, chapterIndex: chapter, thread, api: api.current })
    // Reader installs its API after asynchronous parsing/rendering.
    const timer = setInterval(() => { if (api.current) { onCurrent?.({ info, chapterIndex: chapter, thread, api: api.current }); clearInterval(timer) } }, 100)
    return () => clearInterval(timer)
  }, [info, chapter, thread, onCurrent])
  useEffect(() => () => abort.current?.abort(), [])
  const documentChange = useCallback((next: DocumentInfo | undefined) => { setInfo(next); setChapter(0) }, [])
  const run = async (override?: string) => {
    if (!thread || busyRef.current || !(override ?? input).trim()) return
    busyRef.current = true; setBusy(true); setError('')
    const text = override ?? input; setInput(''); setFollowUp(undefined)
    const ac = new AbortController(); abort.current = ac
    const skill = prompts.find(p => p.id === capability.current && p.kind === 'capability')
    const task = !override && skill?.instruction ? `${skill.instruction}\n\n${text}` : text
    const result = await agent.current.run(thread, task, ac.signal, () => redraw(n => n + 1), quote)
    setTurn(result); clearQuote?.(); busyRef.current = false; setBusy(false)
    if (!override && result.status === 'completed' && skill?.followUpInstruction) setFollowUp({ threadId: thread.id, text: skill.followUpInstruction, label: skill.followUpLabel ?? '继续' })
    try { await ports.store.put('threads', thread.id, thread); await ports.store.put('turns', result.id, result) } catch { setError('会话未能保存，本次内容仍在窗口中。') }
  }
  const CurrentView = views.find(v => v.id === view)?.component
  const capabilities = prompts.filter(p => p.kind === 'capability' && (p.scope === 'selection' ? !!quote?.length && scope === 'chapter' : p.scope === scope))
  const panel = <aside className="session-panel">
    <header><h2>对话</h2><Button onClick={() => setOpen(false)}>收起</Button></header>
    {!providerId && <p>尚未配置模型。<Button onClick={() => setView('settings')}>打开设置</Button></p>}
    {full && threadForContent && <label>范围<select value={scope} onChange={e => setScope(e.target.value as 'chapter' | 'volume')} disabled={busy}><option value="chapter">当前章</option><option value="volume">本册结构</option></select></label>}
    {quote?.length ? <div className="quote-card">已附带选中文字<Button onClick={clearQuote}>移除引用</Button></div> : null}
    <div className="session-items" aria-live="polite">{thread?.items.map(item => <article key={item.id} data-kind={item.kind}><strong>{item.kind === 'assistant' ? '回答' : item.kind === 'user' ? '提问' : item.toolName}</strong><p>{item.text}</p>{item.reasoning && <details><summary>思考过程</summary>{item.reasoning}</details>}</article>)}</div>
    {busy && <p role="status">正在处理…</p>}
    {turn && <p role="status">{turn.error ?? '已完成'} · 输入 {turn.usage.inputTokens} / 输出 {turn.usage.outputTokens} tokens · 缓存 {turn.usage.cachedPrefixTokens < 0 ? '未知' : turn.usage.cachedPrefixTokens}</p>}
    {agent.current.stability.diagnostics.length > 0 && <details><summary>前缀诊断</summary>{agent.current.stability.diagnostics.map((d, i) => <p key={i}>{d.id}：{d.reason}</p>)}</details>}
    {error && <p role="alert">{error}</p>}
    <label>任务<select onChange={e => { capability.current = e.target.value }}><option value="">自由提问</option>{capabilities.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
    <textarea aria-label="输入问题" value={input} onChange={e => setInput(e.target.value)} />
    <div><Button disabled={!providerId || busy || !input.trim() || !thread} onClick={() => void run()}>发送</Button>{busy && <Button onClick={() => abort.current?.abort()}>停止</Button>}{followUp?.threadId === thread?.id && <Button disabled={busy} onClick={() => void run(followUp!.text)}>{followUp?.label}</Button>}</div>
  </aside>
  return <div className="native-shell">
    <nav className="shell-navigation"><Button onClick={() => setView('reading')}>阅读</Button>{views.map(v => <Button key={v.id} onClick={() => setView(v.id)}>{v.title}</Button>)}
      {profileChange && <label><input type="checkbox" checked={full} disabled={busy} onChange={e => { const enabled = e.target.checked; void profileChange(enabled).then(() => { setFull(enabled); redraw(n => n + 1) }).catch(e => setError(String(e))) }} />学习插件</label>}
      <Button onClick={() => setOpen(v => !v)}>对话</Button>
      {props.chooseLocalContent && <Button disabled={busy} onClick={() => { void props.chooseLocalContent!().catch(() => setError('本地资料清单无效，请选择冻结的发布目录。')) }}>打开本地资料</Button>}
      {props.checkForUpdates && <Button disabled={busy} onClick={() => { void props.checkForUpdates!().then(setError).catch(() => setError('更新失败，请稍后重试。')) }}>检查更新</Button>}
    </nav>
    {view === 'reading' ? <ReadingApp source={source} readerApiRef={api} onDocumentChange={documentChange} onChapterChange={setChapter}
      toolbar={<SlotHost registry={registry.slots} slot="toolbar" />} readerSlots={{ sidePanel: open ? panel : undefined, toolbarSlot: <SlotHost registry={registry.slots} slot="reader-toolbar" /> }} /> : <main className="shell-view">{CurrentView && <SlotBoundary key={view}><CurrentView /></SlotBoundary>}{open && panel}</main>}
    {view === 'reading' && open && !info && panel}
    {error && !open && <p role="status">{error}</p>}
  </div>
}
