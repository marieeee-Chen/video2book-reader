import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '../../../packages/app/src/AppShell.tsx'
import { bootstrap } from '../../../packages/app/src/bootstrap.ts'
import { indexedStore } from '../../../packages/app/src/store.ts'
import type { Item } from '../../../packages/agent/src/types.ts'
import { loadStudy, loadModels } from 'virtual:business-plugins'
import { mobileNet, mobileSecrets, mobileFs } from './ports.ts'
import '@app/reader/styles.css'
export function App() {
  const [quote, setQuote] = useState<Item['attachments']>(), [app, setApp] = useState<Awaited<ReturnType<typeof bootstrap>>>(), [error, setError] = useState('')
  const clearQuote = useCallback(() => setQuote(undefined), [])
  useEffect(() => {
    let cancelled = false, active: Awaited<ReturnType<typeof bootstrap>> | undefined
    const url = import.meta.env.VITE_RELEASE_MANIFEST ?? `${location.origin}${import.meta.env.BASE_URL}manifest.json`
    void bootstrap({ net: mobileNet(), secret: mobileSecrets(), fs: mobileFs(), store: indexedStore('course-reader-mobile') }, url, { loadStudy, loadModels }, setQuote).then(result => { active = result; if (cancelled) void result.runtime.dispose(); else setApp(result) }).catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true; if (active) void active.runtime.dispose() }
  }, [])
  if (error) return <p role="alert">{error}</p>
  if (!app) return <p>正在装配阅读器…</p>
  return <AppShell {...app} quote={quote} clearQuote={clearQuote} />
}
