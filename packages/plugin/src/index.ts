import type { ComponentType } from 'react'
import type { Ports } from '../../ports/src/index.ts'
import type { ContentQuery } from '../../reader/src/content/query.ts'
import type { ContextSegment, LlmAdapter, Thread, Tool } from '../../agent/src/types.ts'
export type { ContextSegment, LlmAdapter, Tool } from '../../agent/src/types.ts'
export type Disposer = () => void
export class Registry<T extends { id: string }> {
  private items = new Map<string, T>()
  private listeners = new Set<() => void>()
  register(item: T): Disposer {
    if (this.items.has(item.id)) throw new Error(`重复贡献：${item.id}`)
    this.items.set(item.id, item); this.emit()
    let removed = false
    return () => { if (!removed) { removed = true; this.items.delete(item.id); this.emit() } }
  }
  get(id: string): T | undefined { return this.items.get(id) }
  list(): T[] { return [...this.items.values()] }
  subscribe(fn: () => void): Disposer { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit() { for (const fn of this.listeners) { try { fn() } catch { console.error('扩展订阅者执行失败') } } }
}
export type ViewContribution = { id: string; title: string; component: ComponentType }
export type SlotContribution = { id: string; slot: string; order: number; component: ComponentType }
export type PromptContribution = { id: string; kind: 'system' | 'capability'; order: number; text?: string; label?: string; scope?: string; instruction?: string; followUpInstruction?: string; followUpLabel?: string }
export type ContextContribution = { id: string; order: number; required?: boolean; provide(exec: { thread: Thread; signal: AbortSignal }): Promise<ContextSegment[]> }
export type ProviderContribution = { id: string; adapter: LlmAdapter; model: string }
export function createRegistries() { return { views: new Registry<ViewContribution>(), slots: new Registry<SlotContribution>(), tools: new Registry<Tool>(), context: new Registry<ContextContribution>(), prompts: new Registry<PromptContribution>(), providers: new Registry<ProviderContribution>() } }
export type Registries = ReturnType<typeof createRegistries>
export type ContributionKind = keyof Registries
export type PluginContext = Registries & { ports: Ports; content: ContentQuery; config: Readonly<Record<string, unknown>>; onDispose(fn: Disposer): void }
export type Activation = { kind: 'onStart' } | { kind: 'onView'; viewId: string } | { kind: 'onDemand' }
export type PluginManifest = { id: string; name?: string; version?: string; description?: string; activation: Activation | 'onStart' | 'onView' | 'onDemand'; contributes: ContributionKind[] }
export type Plugin = { manifest: PluginManifest; setup(ctx: PluginContext): void | Promise<void> }
export class PluginRuntime {
  readonly registries = createRegistries()
  readonly failures = new Map<string, string>()
  private active = new Map<string, Disposer[]>()
  private loading = new Map<string, Promise<void>>()
  private available = new Map<string, { manifest: PluginManifest; loader: () => Promise<Plugin> }>()
  private activating = new Map<string, Promise<void>>()
  private closing = false
  constructor(private services: Pick<PluginContext, 'ports' | 'content' | 'config'>) {}
  get ports() { return this.services.ports }
  register(manifest: PluginManifest, loader: () => Promise<Plugin>): Disposer {
    if (this.closing) throw new Error('插件运行时已关闭')
    if (this.available.has(manifest.id)) throw new Error('重复插件声明：' + manifest.id)
    this.available.set(manifest.id, { manifest, loader })
    return () => { this.available.delete(manifest.id); void this.unload(manifest.id) }
  }
  private async activate(id: string) {
    const entry = this.available.get(id)
    if (!entry || this.active.has(id) || this.closing) return
    if (this.activating.has(id)) return this.activating.get(id)
    const pending = (async () => {
      try {
        const plugin = await entry.loader()
        if (this.closing || this.available.get(id) !== entry) return
        if (plugin.manifest.id !== id) throw new Error('插件声明与实现身份不一致')
        await this.load(plugin)
      } catch (error) { this.failures.set(id, String(error)) }
    })()
    this.activating.set(id, pending)
    try { await pending } finally { this.activating.delete(id) }
  }
  async start() {
    for (const entry of this.available.values()) {
      const activation = entry.manifest.activation
      if (activation === 'onStart' || typeof activation === 'object' && activation.kind === 'onStart') await this.activate(entry.manifest.id)
    }
  }
  async activateView(viewId: string) {
    for (const entry of this.available.values()) {
      const activation = entry.manifest.activation
      if (typeof activation === 'object' && activation.kind === 'onView' && activation.viewId === viewId) await this.activate(entry.manifest.id)
    }
  }
  async activateDemand(id: string) { await this.activate(id) }
  async load(plugin: Plugin): Promise<void> {
    if (this.closing) throw new Error('插件运行时已关闭')
    const id = plugin.manifest.id
    if (this.active.has(id)) return
    if (this.loading.has(id)) return this.loading.get(id)
    const pending = Promise.resolve().then(() => this.setup(plugin))
    this.loading.set(id, pending)
    try { await pending } finally { this.loading.delete(id) }
  }
  private async setup(plugin: Plugin) {
    const disposers: Disposer[] = [], scoped: Partial<Registries> = {}
    for (const kind of Object.keys(this.registries) as ContributionKind[]) {
      const registry = this.registries[kind]
      scoped[kind] = {
        register: (item: never) => {
          if (!plugin.manifest.contributes.includes(kind)) console.warn(`插件 ${plugin.manifest.id} 未声明贡献点 ${kind}`)
          const dispose = registry.register(item); disposers.push(dispose); return dispose
        },
        get: (id: string) => registry.get(id), list: () => registry.list(),
        subscribe: (fn: () => void) => { const dispose = registry.subscribe(fn); disposers.push(dispose); return dispose },
      } as never
    }
    try {
      await plugin.setup({ ...this.services, ...scoped as Registries, onDispose: fn => disposers.push(fn) })
      if (this.closing) throw new Error('插件运行时已关闭')
      this.active.set(plugin.manifest.id, disposers); this.failures.delete(plugin.manifest.id)
    } catch (error) {
      for (const dispose of disposers.reverse()) { try { dispose() } catch { /* finish rollback */ } }
      this.failures.set(plugin.manifest.id, String(error))
    }
  }
  async unload(id: string) {
    await this.loading.get(id)
    for (const dispose of (this.active.get(id) ?? []).reverse()) { try { dispose() } catch { /* finish cleanup */ } }
    this.active.delete(id)
  }
  async dispose() {
    this.closing = true
    await Promise.allSettled([...this.activating.values(), ...this.loading.values()])
    for (const id of [...this.active.keys()].reverse()) await this.unload(id)
    this.available.clear()
  }
}
export function mergeConfig(...layers: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeConfig((result[key] as Record<string, unknown>) ?? {}, value as Record<string, unknown>) : value
  }
  return result
}
