import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '../../../packages/app/src/AppShell.tsx'
import { bootstrap } from '../../../packages/app/src/bootstrap.ts'
import { indexedStore } from '../../../packages/app/src/store.ts'
import { browserNet, memorySecrets, type Ports } from '../../../packages/ports/src/index.ts'
import type { Item } from '../../../packages/agent/src/types.ts'
import { loadStudy, loadModels } from 'virtual:business-plugins'
import { netFetch, runtime } from './net-port.ts'
import { strongholdSecrets } from './secret-port.ts'
import { desktopFs } from './fs-port.ts'
import { desktopUpdate } from './updater.ts'
import { chooseLocalContent } from './local-content.ts'
import type { ContentSource } from '../../../packages/reader/src/types.ts'
import '@app/reader/styles.css'
export function App() {
  const [quote, setQuote] = useState<Item['attachments']>(), [app, setApp] = useState<Awaited<ReturnType<typeof bootstrap>>>(), [error, setError] = useState('')
  const [localSource, setLocalSource] = useState<ContentSource>()
  const chooseLocal = useCallback(async () => { const source = await chooseLocalContent(); if (source) { setApp(undefined); setLocalSource(source) } }, [])
  const clearQuote = useCallback(() => setQuote(undefined), [])
  useEffect(() => {
    let cancelled = false, active: Awaited<ReturnType<typeof bootstrap>> | undefined
    const ports: Ports = { net: runtime === 'tauri' ? { fetch: netFetch } : browserNet(), store: indexedStore(), secret: runtime === 'tauri' ? strongholdSecrets() : memorySecrets(), ...(runtime === 'tauri' ? { fs: desktopFs() } : {}) }
    const url = import.meta.env.VITE_RELEASE_MANIFEST ?? `${location.origin}${import.meta.env.BASE_URL}manifest.json`
    void bootstrap(ports, url, { loadStudy, loadModels }, setQuote, localSource).then(result => { active = result; if (cancelled) void result.runtime.dispose(); else setApp(result) }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true; if (active) void active.runtime.dispose() }
  }, [localSource])
  if (error) return <p role="alert">{error}</p>
  if (!app) return <p>正在装配阅读器…</p>
  return <AppShell {...app} quote={quote} clearQuote={clearQuote} checkForUpdates={runtime === 'tauri' ? desktopUpdate : undefined} chooseLocalContent={runtime === 'tauri' ? chooseLocal : undefined} />
}
