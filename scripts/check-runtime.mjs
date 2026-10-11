import assert from 'node:assert/strict'
import test from 'node:test'
import { createReleaseSource, sha256 } from '../packages/reader/src/content/release-source.ts'
import { createLocalDirSource } from '../packages/reader/src/content/local-source.ts'
import { createContentQuery } from '../packages/reader/src/content/query.ts'
import { Agent, createThread, messagesFromItems, StabilityTracker } from '../packages/agent/src/index.ts'
import { PluginRuntime, createRegistries, mergeConfig } from '../packages/plugin/src/index.ts'
import { memoryStore, memorySecrets, browserNet } from '../packages/ports/src/index.ts'
import { createModelAdapter, requestBody, validateModel, sse } from '../plugins/custom-model/src/index.ts'
import { createStudyPlugin, studyThread } from '../plugins/study/src/index.ts'
import { createPositionStore } from '../packages/app/src/reading/reading-position.ts'
const ac = () => new AbortController()
const bytes = text => new TextEncoder().encode(text)
async function fixture() {
  const body = '# 册名\n\n## 第一章\n\n第一章依据。\n\n## 第二章\n\n第二章依据。\n'
  const doc = { id: '计算机/课程/textbooks/书.md', path: '计算机/课程/textbooks/书.md', document_uid: 'doc-1', course_uid: 'course-1', kind: 'volume', product_type: 'textbook', size: bytes(body).length, sha256: await sha256(body), title: '册名', originIndex: 1,
    source: { repo_id: 'owned', role: 'owned_publish', path: '计算机/课程/textbooks/书.md', commit: 'a'.repeat(40), github: { owner: 'fixture', name: 'repo' } } }
  const course = { id: '课程', course_uid: 'course-1', title: '课程', direction: '', publishPath: '计算机/课程', categoryPaths: ['computer'], tags: [], volumes: [doc], notes: [], subtitles: [], assets: [], bytes: doc.size, source_role: 'owned_publish', scope_description: '夹具完整范围', delivery_scope: 'full_course' }
  const manifest = { manifestVersion: 3, release_id: 'fixture-r1', content_base: 'releases/fixture-r1/courses/', reader_compatibility: { min: 3, max: 3 }, generatedAt: '2026-10-11', categories: [{ id: 'computer', name: '计算机' }], aliases: { courses: { old: '课程' }, documents: { 'old.md': doc.id } }, courses: [course], stats: {} }
  return { body, doc, course, manifest }
}
function responseEvents(frames) { return new Response(new ReadableStream({ start(c) { for (const data of frames) c.enqueue(bytes(data)); c.close() } })) }
const services = () => ({ ports: { net: browserNet(), secret: memorySecrets(), store: memoryStore() }, content: {}, config: {} })
test('本地发布目录校验同版本正文，拒绝目录外的远端回退', async () => {
  const f=await fixture(), requested=[]
  const local=createLocalDirSource(async path=>{requested.push(path);if(path==='manifest.json')return bytes(JSON.stringify(f.manifest));if(path==='courses/'+f.doc.id)return bytes(f.body);throw Error('missing')})
  assert.equal(await local.loadDocument(f.doc.id),f.body);assert.deepEqual(requested,['manifest.json','courses/'+f.doc.id])
  const missing=createLocalDirSource(async path=>{if(path==='manifest.json')return bytes(JSON.stringify(f.manifest));throw Error('missing')});await assert.rejects(()=>missing.loadDocument(f.doc.id),/不可用/)
})
test('延迟插件只在匹配视图加载；关闭中完成的 setup 不遗留贡献', async () => {
  const runtime=new PluginRuntime(services());let imported=0,release
  const manifest={id:'lazy',activation:{kind:'onView',viewId:'later'},contributes:['prompts']}
  runtime.register(manifest,async()=>{imported++;return {manifest,setup(ctx){ctx.prompts.register({id:'later',kind:'system',order:0,text:'later'})}}})
  await runtime.start();await runtime.activateView('other');assert.equal(imported,0);await Promise.all([runtime.activateView('later'),runtime.activateView('later')]);assert.equal(imported,1);assert.equal(runtime.registries.prompts.list().length,1)
  const pending=runtime.load({manifest:{id:'pending',activation:'onStart',contributes:['prompts']},async setup(ctx){ctx.prompts.register({id:'pending',kind:'system',order:1});await new Promise(resolve=>{release=resolve})}})
  await new Promise(resolve=>setTimeout(resolve,0));const closing=runtime.dispose();release();await pending;await closing;assert.equal(runtime.registries.prompts.list().length,0)
})
test('同长度改写与缓存污染拒绝；旧链接只读所选版本', async () => {
  const f = await fixture(), paths = [], cache = new Map()
  const source = createReleaseSource({ manifestUrl: 'https://fixture.local/reader/manifest.json', cache: { async get(k) { return cache.get(k) }, async set(k,t) { cache.set(k,t) } }, fetch: async url => { paths.push(String(url)); return new Response(String(url).endsWith('manifest.json') ? JSON.stringify(f.manifest) : f.body) } })
  assert.equal((await source.loadCourse('old')).course_uid, 'course-1')
  assert.equal(await source.loadDocument('old.md'), f.body)
  const key = [...cache.keys()][0]; cache.set(key, f.body.replace('第一章依据', '假的章依据'))
  assert.equal(await source.loadDocument(f.doc.id), f.body)
  assert.equal(paths.length, 3)
  assert.match(paths[1], /releases\/fixture-r1\/courses\//)
  const broken = createReleaseSource({ manifestUrl: 'https://fixture.local/manifest.json', fetch: async url => new Response(String(url).endsWith('manifest.json') ? JSON.stringify(f.manifest) : f.body.replace('第一章依据', '假的章依据')) })
  await assert.rejects(() => broken.loadDocument(f.doc.id), /哈希不符/)
})
test('来源回退只访问正文声明的固定提交；无分支树回退', async () => {
  const f = await fixture(), paths = []
  const source = createReleaseSource({ manifestUrl: 'https://fixture.local/manifest.json', fetch: async url => { paths.push(String(url)); return new Response(String(url).endsWith('manifest.json') ? JSON.stringify(f.manifest) : String(url).includes('raw.githubusercontent') ? f.body : '', { status: String(url).includes('/releases/') ? 404 : 200 }) } })
  assert.equal(await source.loadDocument(f.doc.id), f.body)
  assert.match(paths.at(-1), new RegExp('/fixture/repo/' + 'a'.repeat(40) + '/'))
  assert.ok(paths.every(p => !p.includes('git/trees') && !p.includes('/main/')))
})
test('离线索引可回退；在线错误清单不偷偷选择旧索引', async () => {
  const f = await fixture(), cache = new Map()
  const indexCache = { async get(k) { return cache.get(k) }, async set(k,v) { cache.set(k,v) } }
  const options = { manifestUrl: 'https://fixture.local/manifest.json', indexCache }
  await createReleaseSource({ ...options, fetch: async () => new Response(JSON.stringify(f.manifest)) }).listCourses()
  assert.equal((await createReleaseSource({ ...options, fetch: async () => { throw Error('offline') } }).listCourses()).length, 1)
  await assert.rejects(() => createReleaseSource({ ...options, fetch: async () => new Response(JSON.stringify({ ...f.manifest, manifestVersion: 2 })) }).listCourses(), /v3/)
})
test('第二业务插件无需修改核心；卸载与 setup 失败全部逆向清理', async () => {
  const runtime = new PluginRuntime(services()), removed = []
  const plugin = { manifest: { id: 'another-business', activation: 'onDemand', contributes: ['prompts', 'context', 'tools'] }, setup(ctx) {
    ctx.prompts.register({ id: 'generic', kind: 'system', order: 0, text: '另一个任务' }); ctx.onDispose(() => removed.push('cleanup'))
    ctx.context.register({ id: 'opaque', order: 1, async provide({ thread }) { return [{ id: 'opaque', order: 1, stability: 'global', group: '', text: JSON.stringify(thread.binding) }] } })
  } }
  await runtime.load(plugin); assert.equal(runtime.registries.prompts.list().length, 1); await runtime.unload(plugin.manifest.id)
  assert.deepEqual(removed, ['cleanup']); assert.equal(runtime.registries.context.list().length, 0)
  await runtime.load({ ...plugin, manifest: { ...plugin.manifest, id: 'bad' }, setup(ctx) { ctx.prompts.register({ id: 'leak', kind: 'system', order: 0 }); throw Error('broken') } })
  assert.equal(runtime.registries.prompts.list().length, 0); assert.ok(runtime.failures.has('bad'))
  assert.deepEqual(mergeConfig({ plugins: { a: { enabled: true }, b: {} } }, { plugins: { a: { enabled: false } } }), { plugins: { a: { enabled: false }, b: {} } })
})
test('通用 Agent：工具参数错误返回结果；安全并行保持顺序；历史组装可重放', async () => {
  const registry = createRegistries(), thread = createThread({ kind: 'another-task', key: 'opaque' }, { arbitrary: true }, 'fixture'), requests = [], executed = []
  registry.prompts.register({ id: 'sys', kind: 'system', order: 0, text: '固定前缀' })
  registry.tools.register({ id: 'read', description: '', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false }, isConcurrencySafe: true, async execute(args) { executed.push(args.name); return { ok: true, text: args.name } } })
  registry.providers.register({ id: 'fixture', model: 'fixture', adapter: { async *stream(req) { requests.push(structuredClone(req.messages)); if (requests.length === 1) { for (const [i,args] of ['{"name":"a"}', '{"name":"b"}', '{}', '{'].entries()) yield { kind: 'tool-call', id: String(i), name: 'read', argsDelta: args }; yield { kind: 'done', finishReason: 'tool-calls' } } else { yield { kind: 'text', delta: '完成' }; yield { kind: 'usage', usage: { inputTokens: 10, outputTokens: 2, cachedPrefixTokens: -1 } }; yield { kind: 'done', finishReason: 'stop' } } } } })
  const turn = await new Agent(registry).run(thread, '开始', ac().signal)
  assert.equal(turn.status, 'completed'); assert.equal(turn.usage.cachedPrefixTokens, -1); assert.deepEqual(executed, ['a','b'])
  const results = thread.items.filter(i => i.kind === 'tool-result'); assert.deepEqual(results.map(i => i.ok), [true,true,false,false])
  assert.equal(requests[1].filter(m => m.role === 'tool').length, 4)
  assert.equal(messagesFromItems(thread.items).find(m => m.toolCalls)?.toolCalls.length, 4)
  for(const call of requests[1].find(m=>m.toolCalls).toolCalls) assert.doesNotThrow(()=>JSON.parse(call.arguments))
})
test('停止在首字节、上下文与工具阶段均有效；无提供者或断流不自动重试', async () => {
  for (const phase of ['provider', 'context', 'tool']) {
    const registry = createRegistries(), thread = createThread({ kind: 'test', key: phase }, {}, 'fixture'), control = ac(); let requests = 0
    if (phase === 'context') registry.context.register({ id: 'wait', order: 0, async provide() { return new Promise(() => {}) } })
    registry.tools.register({ id: 'wait', description: '', inputSchema: {}, isConcurrencySafe: false, async execute() { return new Promise(() => {}) } })
    registry.providers.register({ id: 'fixture', model: '', adapter: { async *stream() { requests++; if (phase === 'tool') { yield { kind: 'tool-call', id: '1', name: 'wait', argsDelta: '{}' }; yield { kind: 'done', finishReason: 'tool-calls' } } else await new Promise(() => {}) } } })
    const task = new Agent(registry).run(thread, 'start', control.signal); setTimeout(() => control.abort(), 10)
    assert.equal((await task).status, 'aborted'); assert.ok(requests <= 1)
    if(phase==='tool') {
      const messages=messagesFromItems(thread.items);assert.equal(messages.at(-1).role,'tool');assert.equal(messages.at(-1).toolCallId,'1')
      registry.providers.get('fixture').adapter={async *stream(req){assert.equal(req.messages.at(-2).role,'tool');yield {kind:'done',finishReason:'stop'}}}
      assert.equal((await new Agent(registry).run(thread,'resume',ac().signal)).status,'completed')
    }
  }
  const registry = createRegistries(); let calls = 0
  assert.equal((await new Agent(registry).run(createThread({ kind: 'x', key: 'x' }, {}), 'hi', ac().signal)).status, 'failed')
  registry.providers.register({ id: 'broken', model: '', adapter: { async *stream() { calls++; yield { kind: 'text', delta: '部分回答' } } } })
  const thread = createThread({ kind: 'x', key: 'x' }, {}, 'broken'), result = await new Agent(registry).run(thread, 'hi', ac().signal)
  assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.equal(thread.items.at(-1).text, '部分回答')
})
test('必需上下文失败阻断模型；工具轮上限和稳定前缀变化阻断', async () => {
  const registry = createRegistries(); let calls = 0, executions = 0
  registry.providers.register({ id: 'x', model: '', adapter: { async *stream() { calls++; yield { kind: 'tool-call', id: String(calls), name: 't', argsDelta: '{}' }; yield { kind: 'done', finishReason: 'tool-calls' } } } })
  registry.tools.register({ id: 't', description: '', inputSchema: {}, isConcurrencySafe: true, async execute() { executions++; return { ok:true, text:'ok' } } })
  const remove = registry.context.register({ id: 'required', order: 0, required: true, async provide() { throw Error('hash changed') } })
  assert.equal((await new Agent(registry).run(createThread({ kind:'x',key:'x' },{},'x'), 'hi', ac().signal)).status, 'failed'); assert.equal(calls,0); remove()
  const result = await new Agent(registry).run(createThread({ kind:'x',key:'x' },{},'x'), 'hi', ac().signal)
  assert.equal(result.status,'failed'); assert.match(result.error,/上限/); assert.equal(executions,16); assert.equal(calls,17)
  registry.context.register({ id: 'unstable', order: 0, async provide() { return [{ id:'s',order:0,stability:'chapter',group:'x',text:String(calls) }] } })
  assert.match((await new Agent(registry).run(createThread({ kind:'x',key:'x' },{},'x'), 'hi', ac().signal)).error, /前缀改变/)
  const tracker = new StabilityTracker(); await tracker.check([{id:'x',order:0,stability:'global',group:'',text:'one'}]); await tracker.check([{id:'x',order:0,stability:'global',group:'',text:'two'}]); assert.equal(tracker.diagnostics.length,1)
})
test('三协议流夹具、未知缓存、工具历史和 Google 签名', async () => {
  const base = { model:'fixture', system:'sys', messages:[{role:'user',content:'hi'}], tools:[], segments:[{id:'sys',order:0,stability:'global',group:'',text:'sys'}],cacheBoundaryIndex:0 }
  const fixtures = [
    ['openai-chat-completions', ['data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n','data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n']],
    ['anthropic-messages', ['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n','data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n','data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n']],
    ['google-native', ['data: {"candidates":[{"content":{"parts":[{"text":"你好"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n']],
  ]
  for (const [protocol,frames] of fixtures) {
    const secrets = memorySecrets(); await secrets.set('x','fixture-key'); let sent
    const adapter = createModelAdapter({ id:'x',endpoint:'https://fixture.local/v1',model:'fixture',protocol }, { async fetch(req) { sent = req; const res = responseEvents(frames); return { ok:true,status:200,statusText:'OK',headers:{},body:res.body } } }, secrets)
    const events=[]; for await (const event of adapter.stream(base,ac().signal)) events.push(event)
    assert.equal(events.find(e => e.kind === 'text').delta,'你好'); assert.equal(events.find(e => e.kind === 'usage').usage.cachedPrefixTokens,-1); assert.equal(events.at(-1).finishReason,'stop')
    assert.ok(!sent.url.includes('fixture-key')); assert.ok(!sent.body.includes('fixture-key'))
  }
  const history = { ...base, messages:[{ role:'assistant',content:'',toolCalls:[{id:'1',name:'read',arguments:'{}',metadata:{thoughtSignature:'opaque-sig'}}] },{role:'tool',content:'value',toolCallId:'1',toolName:'read'}] }
  const google = requestBody({protocol:'google-native'},history); assert.equal(google.contents[0].parts[0].thoughtSignature,'opaque-sig'); assert.equal(google.contents[1].parts[0].functionResponse.name,'read')
  const anthropic=requestBody({protocol:'anthropic-messages'},history); assert.equal(anthropic.system[0].cache_control.type,'ephemeral'); assert.equal(anthropic.messages[1].content[0].tool_use_id,'1')
  const thinkingFrames = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"依据"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-think-signature"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ]
  const thoughtAdapter=createModelAdapter({id:'x',endpoint:'https://fixture.local',model:'fixture',protocol:'anthropic-messages'},
    {async fetch(){return {ok:true,status:200,headers:{},body:responseEvents(thinkingFrames).body}}}, memorySecrets())
  const thoughtEvents=[];for await(const event of thoughtAdapter.stream(base,ac().signal))thoughtEvents.push(event)
  const metadata=thoughtEvents.find(e=>e.kind==='assistant-metadata').metadata
  const replay=requestBody({protocol:'anthropic-messages'},{...history,messages:[{...history.messages[0],metadata},history.messages[1]]})
  assert.equal(replay.messages[0].content[0].signature,'opaque-think-signature');assert.equal(replay.messages[0].content[0].thinking,'依据')
  assert.throws(() => validateModel({id:'x',model:'x',protocol:'google-native',endpoint:'https://fixture.local/?api_key=secret'}))
  const encoded=bytes(': comment\r\nevent: delta\r\ndata: 你\r\ndata: 好\r\n\r\n'), stream=new ReadableStream({start(c){for(const byte of encoded)c.enqueue(new Uint8Array([byte]));c.close()}}), parsed=[]
  for await(const frame of sse(stream,ac().signal))parsed.push(frame); assert.deepEqual(parsed,[{event:'delta',data:'你\n好'}])
})
test('消息附件重放在原用户消息中，工具结果保持在最后且不进入前缀', async () => {
  const runtime = new PluginRuntime(services()), thread = createThread({kind:'second-business',key:'1'},{},'p')
  let rounds=0, observed=[]
  runtime.registries.context.register({id:'opaque-attachment',order:10,required:true,async provide({thread}){
    return thread.items.filter(i=>i.kind==='user'&&i.attachments?.length).map(i=>({id:i.id,itemId:i.id,order:10,stability:'turn',group:'',text:'opaque-reference'}))
  }})
  runtime.registries.tools.register({id:'read',description:'read',inputSchema:{type:'object'},isConcurrencySafe:true,async execute(){return {ok:true,text:'tool-value'}}})
  runtime.registries.providers.register({id:'p',model:'fixture',adapter:{async *stream(req){
    observed.push(structuredClone(req.messages));assert.ok(!req.system.includes('opaque-reference'))
    if(rounds++===0){yield {kind:'tool-call',id:'c',name:'read',argsDelta:'{}'};yield {kind:'done',finishReason:'tool-calls'}}
    else {yield {kind:'text',delta:'answer'};yield {kind:'done',finishReason:'stop'}}
  }}})
  const agent=new Agent(runtime.registries)
  assert.equal((await agent.run(thread,'first',ac().signal,undefined,[{kind:'business-data',data:{}}])).status,'completed')
  assert.equal(observed[1].at(-1).role,'tool');assert.equal(observed[1][0].content,'first\n\nopaque-reference')
  await agent.run(thread,'next',ac().signal)
  assert.equal(observed[2][0].content,'first\n\nopaque-reference');assert.equal(observed[2].at(-1).content,'next')
})
test('正文版本绑定章会话和进度，元数据变化可续用，旧会话不注入新正文', async () => {
  const f = await fixture(), store = memoryStore()
  const make = manifest => createContentQuery(createReleaseSource({manifestUrl:'https://fixture.local/manifest.json',fetch:async url=>new Response(String(url).endsWith('manifest.json')?JSON.stringify(manifest):f.body)}))
  const query=make(f.manifest), info=await query.source.documentInfo(f.doc.id), first=await studyThread(info,1,query,store,'m')
  const rename=structuredClone(f.manifest);rename.release_id='fixture-r2';rename.content_base='releases/fixture-r2/courses/';rename.courses[0].title='新标题'
  const q2=make(rename), second=await studyThread(await q2.source.documentInfo(f.doc.id),1,q2,store,'m');assert.equal(first.id,second.id)
  assert.notEqual(first.id,(await studyThread(info,2,query,store,'m')).id)
  const changed=structuredClone(f.manifest); f.body=f.body.replace('第一章依据','更新章依据'); changed.courses[0].volumes[0].sha256=await sha256(f.body)
  const q3=make(changed), i3=await q3.source.documentInfo(f.doc.id); assert.notEqual(first.id,(await studyThread(i3,1,q3,store,'m')).id);assert.ok((await store.get('threads',first.id)).staleAt)
  const values=new Map(), positions=createPositionStore({ getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v) });positions.put(info,{chapterIndex:2,blockId:'b'});assert.equal(positions.get(info).position.chapterIndex,2);assert.equal(positions.get(i3).stale,true)
  // DOM listeners are the host's responsibility; content/tool contributions can run without a browser.
  const runtime=new PluginRuntime({...services(),content:q3}); await runtime.load(createStudyPlugin({current:()=>({info:i3,chapterIndex:1}),api:()=>null,onQuote:()=>{}}))
  assert.equal(runtime.registries.prompts.list().filter(p=>p.kind==='capability').length,13);assert.equal(runtime.registries.tools.list().length,4);await runtime.dispose();assert.equal(runtime.registries.tools.list().length,0)
})
