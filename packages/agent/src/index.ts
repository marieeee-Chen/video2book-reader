import type { Registries } from '../../plugin/src/index.ts'
import type { ContextSegment, Item, Message, Thread, Turn, Usage } from './types.ts'
export type * from './types.ts'
const id = () => crypto.randomUUID()
export function createThread(scope: Thread['scope'], binding: unknown, modelRef?: string): Thread { return { id: id(), scope, binding, modelRef, schemaVersion: 1, items: [] } }
export async function fingerprint(text: string): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, '0')).join('')
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Stopped', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export function messagesFromItems(items: Item[]): Message[] {
  const result: Message[] = []
  for (const item of items) {
    if (item.kind === 'user') result.push({ role: 'user', content: item.text })
    else if (item.kind === 'assistant' && (item.text || item.status === 'completed')) result.push({ role: 'assistant', content: item.text, metadata: item.metadata })
    else if (item.kind === 'tool-call') {
      let previous = result[result.length - 1]
      if (previous?.role !== 'assistant') { previous = { role: 'assistant', content: '' }; result.push(previous) }
      previous.toolCalls ??= []
      previous.toolCalls.push({ id: item.callId!, name: item.toolName!, arguments: JSON.stringify(item.args), metadata: item.metadata })
    } else if (item.kind === 'tool-result') result.push({ role: 'tool', content: item.text, toolCallId: item.callId, toolName: item.toolName })
  }
  return result
}
export class StabilityTracker {
  readonly diagnostics: { id: string; group: string; reason: string }[] = []
  private previous = new Map<string, string>()
  async check(segments: ContextSegment[]) {
    const fingerprints = []
    for (const segment of segments) {
      const sha256 = await fingerprint(segment.text)
      fingerprints.push({ id: segment.id, sha256, stability: segment.stability })
      if (segment.stability === 'turn') continue
      const key = JSON.stringify([segment.id, segment.stability, segment.stability === 'global' ? '' : segment.group])
      const old = this.previous.get(key)
      if (old && old !== sha256) this.diagnostics.push({ id: segment.id, group: segment.group, reason: '稳定前缀改变，缓存可能失效' })
      this.previous.set(key, sha256)
    }
    return fingerprints
  }
}
export function schemaAccepts(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const obj = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    if (((schema.required ?? []) as string[]).some(key => !(key in obj))) return false
    if (schema.additionalProperties === false && Object.keys(obj).some(key => !(key in properties))) return false
    if (Object.entries(properties).some(([key, rule]) => key in obj && !schemaAccepts(obj[key], rule))) return false
  } else if (type === 'string' && typeof value !== 'string') return false
  else if (type === 'integer' && !Number.isInteger(value)) return false
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false
  else if (type === 'boolean' && typeof value !== 'boolean') return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (typeof value === 'number' && (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum)) return false
  return true
}
export class Agent {
  readonly stability = new StabilityTracker()
  private running = new Set<string>()
  constructor(private registry: Registries) {}
  async run(thread: Thread, input: string, signal: AbortSignal, onChange: () => void = () => {}, attachments?: Item['attachments'], maxToolRounds = 16): Promise<Turn> {
    if (this.running.has(thread.id)) throw new Error('同一会话已有正在进行的请求')
    if (thread.staleAt) throw new Error('会话绑定的内容已更新，请开始新版本会话')
    this.running.add(thread.id)
    const firstItem = thread.items.length
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedPrefixTokens: 0 }
    const turn: Turn = { id: id(), threadId: thread.id, status: 'running', startedAt: Date.now(), usage, fingerprints: [] }
    const user: Item = { id: id(), kind: 'user', text: input, status: 'completed', attachments }
    thread.items.push(user); onChange()
    let assistant: Item | undefined, turnPrefix: string | undefined
    const toolDefinitions = this.registry.tools.list().map(tool => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })).sort((a, b) => a.id.localeCompare(b.id))
    const provider = this.registry.providers.get(thread.modelRef ?? '')
    try {
      signal.throwIfAborted()
      if (!provider) throw new Error('尚未配置模型提供者；可继续阅读并在设置中添加自定义模型')
      for (let round = 0; ; round++) {
        signal.throwIfAborted()
        const systemPrompts = this.registry.prompts.list().filter(p => p.kind === 'system').sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        const segments: ContextSegment[] = systemPrompts.map(p => ({ id: p.id, order: p.order, stability: 'global', group: '', text: p.text ?? '' }))
        for (const context of this.registry.context.list().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
          try { segments.push(...await abortable(context.provide({ thread, signal }), signal)) }
          catch (error) {
            signal.throwIfAborted()
            if (context.required) throw new Error('必需上下文读取失败：' + String(error))
            this.stability.diagnostics.push({ id: context.id, group: thread.scope.key, reason: '上下文读取失败：' + String(error) })
          }
        }
        segments.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        const prefix = segments.filter(s => s.stability !== 'turn')
        const signature = JSON.stringify(prefix)
        if (turnPrefix !== undefined && turnPrefix !== signature) throw new Error('工具轮之间前缀改变，请开始新请求')
        turnPrefix = signature; turn.fingerprints = await this.stability.check(segments)
        const system = prefix.map(s => s.text).join('\n\n')
        const messages = messagesFromItems(thread.items)
        const users = thread.items.filter(item => item.kind === 'user')
        const userMessages = messages.filter(message => message.role === 'user')
        for (const segment of segments.filter(s => s.stability === 'turn')) {
          const index = segment.itemId ? users.findIndex(item => item.id === segment.itemId) : users.length - 1
          const target = userMessages[index]
          if (!target) throw new Error('消息上下文未绑定到有效的用户消息')
          target.content += '\n\n' + segment.text
        }
        assistant = { id: id(), kind: 'assistant', text: '', reasoning: '', status: 'streaming' }
        thread.items.push(assistant); onChange()
        const calls = new Map<string, { id: string; name: string; args: string; metadata?: Record<string, unknown> }>()
        let finish: 'stop' | 'tool-calls' | 'length' | 'error' | undefined
        const iterator = provider.adapter.stream({ model: provider.model, system, messages, tools: toolDefinitions, segments: prefix, cacheBoundaryIndex: prefix.length - 1 }, signal)[Symbol.asyncIterator]()
        try {
          for (;;) {
            const next = await abortable(iterator.next(), signal)
            if (next.done) break
            const event = next.value
            signal.throwIfAborted()
            if (event.kind === 'text') assistant.text += event.delta
            else if (event.kind === 'reasoning') assistant.reasoning += event.delta
            else if (event.kind === 'assistant-metadata') assistant.metadata = { ...assistant.metadata, ...event.metadata }
            else if (event.kind === 'tool-call') {
              const call = calls.get(event.id) ?? { id: event.id, name: event.name, args: '' }
              call.name ||= event.name; call.args += event.argsDelta; call.metadata = event.metadata ?? call.metadata; calls.set(event.id, call)
            } else if (event.kind === 'usage') {
              assistant.usage = event.usage
              usage.inputTokens += event.usage.inputTokens; usage.outputTokens += event.usage.outputTokens
              usage.cachedPrefixTokens = usage.cachedPrefixTokens < 0 || event.usage.cachedPrefixTokens < 0 ? -1 : usage.cachedPrefixTokens + event.usage.cachedPrefixTokens
            } else if (event.kind === 'done') finish = event.finishReason
            onChange()
          }
        } finally { if (signal.aborted) void iterator.return?.().catch(() => undefined) }
        if (!assistant.usage) usage.cachedPrefixTokens = -1
        if (!finish || finish === 'length' || finish === 'error') throw new Error(finish === 'length' ? '输出达到长度上限，已保留收到的文字' : '模型流未正常结束')
        assistant.status = 'completed'
        if (!calls.size && finish === 'stop') { turn.status = 'completed'; break }
        if (!calls.size || finish !== 'tool-calls') throw new Error('模型工具调用与终止原因不一致')
        if (round >= maxToolRounds) throw new Error('达到工具调用上限')
        const jobs = [...calls.values()].map(call => {
          let args: unknown
          try { args = JSON.parse(call.args || '{}') } catch { args = undefined }
          thread.items.push({ id: id(), kind: 'tool-call', text: '', status: 'completed', callId: call.id, toolName: call.name,
            args: args === undefined ? {} : args, metadata: args === undefined ? { ...call.metadata, invalidArguments: call.args } : call.metadata })
          return { call, args, tool: toolDefinitions.find(tool => tool.id === call.name) }
        })
        const execute = async (job: typeof jobs[number]) => {
          const { call, tool, args } = job
          let result: { ok: boolean; text: string }
          try {
            const installed = this.registry.tools.get(call.name)
            if (!tool || !installed || installed.execute !== tool.execute) throw new Error('工具已卸载或改变，请开始新请求')
            if (args === undefined || !schemaAccepts(args, tool.inputSchema)) throw new Error('工具参数不符合声明')
            result = await abortable(tool.execute(args, { thread, signal }), signal)
          } catch (error) { signal.throwIfAborted(); result = { ok: false, text: String(error) } }
          return { id: id(), kind: 'tool-result' as const, text: result.text, status: 'completed' as const, callId: call.id, toolName: call.name, ok: result.ok }
        }
        // Unsafe jobs are barriers; results remain in model call order.
        for (let i = 0; i < jobs.length;) {
          if (!jobs[i].tool?.isConcurrencySafe) { thread.items.push(await execute(jobs[i++])); onChange(); continue }
          const group: typeof jobs = []
          while (i < jobs.length && jobs[i].tool?.isConcurrencySafe) group.push(jobs[i++])
          thread.items.push(...await Promise.all(group.map(execute))); onChange()
        }
      }
    } catch (error) {
      turn.status = signal.aborted ? 'aborted' : 'failed'; turn.error = String(error)
      if (assistant?.status === 'streaming') assistant.status = 'failed'
    } finally {
      // A stopped/failed tool must have a response in replayable provider history.
      const results = new Map<string, number>()
      for (const item of thread.items.slice(firstItem)) if (item.kind === 'tool-result') results.set(item.callId!, (results.get(item.callId!) ?? 0) + 1)
      for (const item of thread.items.slice(firstItem)) if (item.kind === 'tool-call') {
        const matched = results.get(item.callId!) ?? 0
        if (matched) results.set(item.callId!, matched - 1)
        else thread.items.push({ id: id(), kind: 'tool-result', callId: item.callId, toolName: item.toolName,
          text: turn.status === 'aborted' ? '工具未完成：请求已停止' : '工具未完成：本轮失败', status: 'failed', ok: false })
      }
      if (assistant && !assistant.usage) usage.cachedPrefixTokens = -1
      turn.endedAt = Date.now(); this.running.delete(thread.id); onChange()
    }
    return turn
  }
}
