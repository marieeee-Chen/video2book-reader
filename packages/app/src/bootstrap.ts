import { createReleaseSource, createContentQuery, type ContentSource, type DocumentInfo, type ReaderApi } from '../../reader/src/index.ts'
import { PluginRuntime, type Plugin } from '../../plugin/src/index.ts'
import type { Thread, Item } from '../../agent/src/types.ts'
import { fingerprint } from '../../agent/src/index.ts'
import type { Ports } from '../../ports/src/index.ts'
import { contentCache, indexCache, assetCache } from './reading/idb-cache.ts'
import type { CustomModel } from './AppShell.tsx'
// The shell supplies loaders. This module never imports business plugins.
export async function bootstrap(ports: Ports, manifestUrl: string, loaders: { loadStudy(): Promise<unknown>; loadModels(): Promise<unknown> }, onQuote: (items: Item['attachments']) => void, localSource?: ContentSource) {
  const contentFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const res = await ports.net.fetch({ url, method: (init?.method ?? 'GET') as 'GET' | 'POST', signal: init?.signal ?? undefined, headers: init?.headers ? Object.fromEntries(new Headers(init.headers)) : undefined })
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  const source = localSource ?? createReleaseSource({ manifestUrl, fetch: contentFetch, cache: contentCache, indexCache, assetCache })
  const query = createContentQuery(source), runtime = new PluginRuntime({ ports, content: query, config: {} })
  let current: { info?: DocumentInfo; chapterIndex: number; thread?: Thread; api: ReaderApi | null } = { chapterIndex: 1, api: null }
  type StudyModule = { createStudyPlugin(opts: { current: () => typeof current; api: () => ReaderApi | null; onQuote: (quote: unknown) => void }): Plugin; studyThread(info: DocumentInfo, chapter: number, query: import('../../reader/src/content/query.ts').ContentQuery, store: Ports['store'], model?: string, scope?: 'chapter' | 'volume'): Promise<Thread> }
  type ModelsModule = { modelPlugin(model: CustomModel): Plugin }
  const study = await loaders.loadStudy() as StudyModule | null
  const models = await loaders.loadModels() as ModelsModule | null
  const studyPlugin = study?.createStudyPlugin({ current: () => current, api: () => current.api, onQuote: quote => onQuote([{ kind: 'quote', data: quote }]) })
  if (studyPlugin) await runtime.load(studyPlugin)
  const settings = await ports.store.getAll('models').catch(() => []) as CustomModel[]
  const activeModel = await ports.store.get('settings', 'active-model').catch(() => undefined) as string | undefined
  const selectedModels = activeModel ? settings.filter(model => model.id === activeModel) : settings.slice(0, 1)
  if (models) for (const model of selectedModels) {
    try { await runtime.load(models.modelPlugin(model)) }
    catch { runtime.failures.set('model-' + model.id, '模型配置无效；请在设置中重新保存') }
  }
  return { runtime, source,
    onCurrent(value: typeof current) { current = value },
    threadForContent: study ? (info: DocumentInfo, chapter: number, model?: string, scope?: 'chapter' | 'volume') => study.studyThread(info, chapter, query, ports.store, model, scope) : undefined,
    async setModel(model: CustomModel, key: string) {
      if (!models) throw new Error('此构建未装载模型适配器')
      // A changed endpoint/model/protocol starts a different model-bound thread.
      // Credential rotation alone keeps the model identity and existing history.
      const identity = await fingerprint(JSON.stringify([model.protocol, model.endpoint, model.model, model.options ?? {}]))
      model = { ...model, id: 'custom-' + identity }
      // Validate URL/protocol before saving credentials/configuration.
      const plugin = models.modelPlugin(model)
      const previous = await ports.store.get('models', model.id) as CustomModel | undefined
      const previousKey = await ports.secret.get(model.id)
      const previousActive = await ports.store.get('settings', 'active-model') as string | undefined
      const previousProviders = runtime.registries.providers.list().map(provider => provider.id)
      try {
        await ports.secret.set(model.id, key)
        await ports.store.put('models', model.id, model)
        for (const id of previousProviders) await runtime.unload('model-' + id)
        await runtime.load(plugin)
        if (runtime.failures.has(plugin.manifest.id)) throw new Error('模型适配器加载失败')
        await ports.store.put('settings', 'active-model', model.id)
      } catch (error) {
        await runtime.unload(plugin.manifest.id)
        if (previousKey === undefined) await ports.secret.delete(model.id); else await ports.secret.set(model.id, previousKey)
        if (previous) { await ports.store.put('models', model.id, previous) }
        else await ports.store.delete('models', model.id)
        if (previousActive) await ports.store.put('settings', 'active-model', previousActive)
        else await ports.store.delete('settings', 'active-model')
        for (const id of previousProviders) {
          const saved = await ports.store.get('models', id) as CustomModel | undefined
          if (saved) await runtime.load(models.modelPlugin(saved))
        }
        throw error
      }
    },
    async profileChange(full: boolean) { if (!studyPlugin) return; if (full) await runtime.load(studyPlugin); else { onQuote(undefined); await runtime.unload(studyPlugin.manifest.id) } },
  }
}
