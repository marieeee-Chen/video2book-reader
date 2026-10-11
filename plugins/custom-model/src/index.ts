import type { LlmAdapter, LlmRequest, Message, Usage } from '../../../packages/agent/src/types.ts'
import type { NetPort, SecretPort } from '../../../packages/ports/src/index.ts'
import type { Plugin } from '../../../packages/plugin/src/index.ts'
export type Protocol = 'openai-chat-completions' | 'anthropic-messages' | 'google-native'
export type ModelConfig = { id: string; endpoint: string; model: string; protocol: Protocol; options?: Record<string, unknown> }
export function validateModel(config: ModelConfig) {
  const url = new URL(config.endpoint)
  if (!config.id.trim() || !config.model.trim() || !['openai-chat-completions', 'anthropic-messages', 'google-native'].includes(config.protocol)) throw new Error('模型配置不完整')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('模型端点必须为 HTTP(S)，密钥单独保存')
}

/** SSE framing survives split UTF-8, CRLF, comments and multiple data lines. */
export async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader(), decoder = new TextDecoder()
  let pending = '', event = 'message', data: string[] = []
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true })
  function line(value: string): { event: string; data: string } | undefined {
    if (!value) { if (!data.length) { event = 'message'; return }; const frame = { event, data: data.join('\n') }; event = 'message'; data = []; return frame }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':'), name = colon < 0 ? value : value.slice(0, colon), content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    if (name === 'event') event = content
    if (name === 'data') data.push(content)
  }
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const frame = line(pending.slice(0, newline).replace(/\r$/, '')); pending = pending.slice(newline + 1)
        if (frame) yield frame
      }
      if (chunk.done) { if (pending) { const frame = line(pending.replace(/\r$/, '')); if (frame) yield frame }; const frame = line(''); if (frame) yield frame; break }
    }
    signal.throwIfAborted()
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
function anthropicMessages(messages: Message[]) {
  const result: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks: Record<string, unknown>[] = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] : []
    if (message.role === 'assistant' && Array.isArray(message.metadata?.anthropicThinking)) blocks.push(...message.metadata.anthropicThinking)
    if (message.role !== 'tool' && message.content) blocks.push({ type: 'text', text: message.content })
    for (const call of message.toolCalls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) })
    if (!blocks.length) continue
    if (result.at(-1)?.role === role) result.at(-1)!.content.push(...blocks)
    else result.push({ role, content: blocks })
  }
  return result
}
export function requestBody(config: ModelConfig, req: LlmRequest): Record<string, unknown> {
  const options = { ...config.options, ...req.options }
  // Identity/auth, context and protocol fields are owned by the adapter, never by extra options.
  if (config.protocol === 'openai-chat-completions') return { ...options, model: req.model, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: req.system }, ...req.messages.map(m => m.role === 'tool' ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content } : {
      role: m.role, content: m.content || null, ...(m.toolCalls ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
    })], ...(req.tools.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.id, description: t.description, parameters: t.inputSchema } })) } : {}),
    ...(req.maxOutputTokens ? { max_completion_tokens: req.maxOutputTokens } : {}) }
  if (config.protocol === 'anthropic-messages') return { ...options, model: req.model, stream: true, max_tokens: req.maxOutputTokens ?? 4096,
    system: req.segments.length ? req.segments.map((s, i) => ({ type: 'text', text: s.text, ...(i === req.cacheBoundaryIndex ? { cache_control: { type: 'ephemeral' } } : {}) })) : [{ type: 'text', text: req.system }],
    messages: anthropicMessages(req.messages), ...(req.tools.length ? { tools: req.tools.map(t => ({ name: t.id, description: t.description, input_schema: t.inputSchema })) } : {}) }
  return { ...options, systemInstruction: { parts: [{ text: req.system }] }, contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.role === 'tool' ? [{ functionResponse: { id: m.toolCallId, name: m.toolName, response: { result: m.content } } }] : [
      ...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map(c => ({ functionCall: { id: c.id, name: c.name, args: JSON.parse(c.arguments) }, ...(c.metadata?.thoughtSignature ? { thoughtSignature: c.metadata.thoughtSignature } : {}) })),
    ],
  })).filter(m => m.parts.length), ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools.map(t => ({ name: t.id, description: t.description, parameters: t.inputSchema })) }] } : {}),
    generationConfig: { ...(typeof options.generationConfig === 'object' ? options.generationConfig : {}), ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}) } }
}
export function createModelAdapter(config: ModelConfig, net: NetPort, secrets: SecretPort): LlmAdapter {
  validateModel(config)
  return { async *stream(req, signal) {
    const key = await secrets.get(config.id); signal.throwIfAborted()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (key) {
      if (config.protocol === 'anthropic-messages') headers['x-api-key'] = key
      else if (config.protocol === 'google-native') headers['x-goog-api-key'] = key
      else headers.authorization = `Bearer ${key}`
    }
    if (config.protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01'
    let endpoint = config.endpoint.replace(/\/$/, '')
    if (config.protocol === 'openai-chat-completions' && !endpoint.endsWith('/chat/completions')) endpoint += '/chat/completions'
    if (config.protocol === 'anthropic-messages' && !endpoint.endsWith('/messages')) endpoint += '/messages'
    if (config.protocol === 'google-native') endpoint += `/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`
    const response = await net.fetch({ url: endpoint, method: 'POST', headers, body: JSON.stringify(requestBody(config, req)), signal, timeoutMs: 120_000 })
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error(`模型请求失败：HTTP ${response.status}`) }
    const calls = new Map<number, { id: string; name: string }>()
    const thinking = new Map<number, Record<string, unknown>>()
    let usage: Usage | undefined, finish: 'stop' | 'tool-calls' | 'length' | 'error' | undefined
    for await (const frame of sse(response.body, signal)) {
      if (frame.data === '[DONE]') break
      const event = JSON.parse(frame.data)
      if (event.error || event.type === 'error') throw new Error('模型端点返回错误')
      if (config.protocol === 'openai-chat-completions') {
        const choice = event.choices?.[0], delta = choice?.delta
        if (delta?.content) yield { kind: 'text', delta: delta.content }
        if (delta?.reasoning_content) yield { kind: 'reasoning', delta: delta.reasoning_content }
        for (const call of delta?.tool_calls ?? []) {
          const previous = calls.get(call.index) ?? { id: call.id, name: call.function?.name ?? '' }
          if (call.id) previous.id = call.id
          if (call.function?.name) previous.name = call.function.name
          calls.set(call.index, previous)
          if (!previous.id) throw new Error('工具流缺少调用身份')
          yield { kind: 'tool-call', id: previous.id, name: previous.name, argsDelta: call.function?.arguments ?? '' }
        }
        if (event.usage) usage = { inputTokens: event.usage.prompt_tokens ?? 0, outputTokens: event.usage.completion_tokens ?? 0, cachedPrefixTokens: event.usage.prompt_tokens_details?.cached_tokens ?? -1 }
        if (choice?.finish_reason) finish = choice.finish_reason === 'tool_calls' ? 'tool-calls' : choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : 'error'
      } else if (config.protocol === 'anthropic-messages') {
        if (event.type === 'message_start') {
          const u = event.message?.usage ?? {}
          usage = { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cachedPrefixTokens: u.cache_read_input_tokens ?? -1, cacheWriteTokens: u.cache_creation_input_tokens }
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          calls.set(event.index, { id: event.content_block.id, name: event.content_block.name })
          yield { kind: 'tool-call', id: event.content_block.id, name: event.content_block.name, argsDelta: Object.keys(event.content_block.input ?? {}).length ? JSON.stringify(event.content_block.input) : '' }
        }
        if (event.type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(event.content_block?.type)) thinking.set(event.index, { ...event.content_block })
        const delta = event.delta
        if (delta?.type === 'text_delta') yield { kind: 'text', delta: delta.text }
        if (delta?.type === 'thinking_delta') {
          const block = thinking.get(event.index); if (block) block.thinking = String(block.thinking ?? '') + delta.thinking
          yield { kind: 'reasoning', delta: delta.thinking }
        }
        if (delta?.type === 'signature_delta') { const block = thinking.get(event.index); if (block) block.signature = String(block.signature ?? '') + delta.signature }
        if (delta?.type === 'input_json_delta') {
          const call = calls.get(event.index); if (!call) throw new Error('工具流缺少起始事件')
          yield { kind: 'tool-call', id: call.id, name: call.name, argsDelta: delta.partial_json }
        }
        if (event.type === 'message_delta') {
          if (usage && event.usage) usage.outputTokens = event.usage.output_tokens ?? usage.outputTokens
          if (delta?.stop_reason) finish = delta.stop_reason === 'tool_use' ? 'tool-calls' : delta.stop_reason === 'end_turn' || delta.stop_reason === 'stop_sequence' ? 'stop' : delta.stop_reason === 'max_tokens' ? 'length' : 'error'
        }
      } else {
        const candidate = event.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text) yield { kind: part.thought ? 'reasoning' : 'text', delta: part.text }
          if (part.functionCall) {
            const call = part.functionCall
            yield { kind: 'tool-call', id: call.id ?? `google-${calls.size}`, name: call.name, argsDelta: JSON.stringify(call.args ?? {}), metadata: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined }
            calls.set(calls.size, { id: call.id, name: call.name })
          }
        }
        if (event.usageMetadata) usage = { inputTokens: event.usageMetadata.promptTokenCount ?? 0, outputTokens: event.usageMetadata.candidatesTokenCount ?? 0, cachedPrefixTokens: event.usageMetadata.cachedContentTokenCount ?? -1 }
        if (candidate?.finishReason) finish = candidate.finishReason === 'STOP' ? calls.size ? 'tool-calls' : 'stop' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'error'
      }
    }
    if (usage) yield { kind: 'usage', usage }
    if (!finish) throw new Error('模型流在结束事件之前断开')
    if (thinking.size) yield { kind: 'assistant-metadata', metadata: { anthropicThinking: [...thinking.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) } }
    yield { kind: 'done', finishReason: finish }
  } }
}
export function modelPlugin(config: ModelConfig): Plugin {
  validateModel(config)
  return { manifest: { id: 'model-' + config.id, activation: 'onStart', contributes: ['providers'] }, setup(ctx) {
    ctx.providers.register({ id: config.id, model: config.model, adapter: createModelAdapter(config, ctx.ports.net, ctx.ports.secret) })
  } }
}
