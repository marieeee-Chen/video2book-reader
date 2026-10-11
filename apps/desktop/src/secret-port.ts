import type { SecretPort } from '../../../packages/ports/src/index.ts'
import { invoke } from '@tauri-apps/api/core'
import { appLocalDataDir, join } from '@tauri-apps/api/path'
import { Stronghold } from '@tauri-apps/plugin-stronghold'
/** Random vault password lives in the OS credential store; config/IndexedDB never receives keys. */
export function strongholdSecrets(): SecretPort {
  let opening: Promise<{ stronghold: Stronghold; store: Awaited<ReturnType<Stronghold['loadClient']>>['getStore'] extends () => infer S ? S : never }> | undefined
  async function vault() {
    opening ??= (async () => {
      const password = await invoke<string>('vault_password')
      const path = await join(await appLocalDataDir(), 'models.hold')
      const stronghold = await Stronghold.load(path, password)
      let client
      try { client = await stronghold.loadClient('models') } catch { client = await stronghold.createClient('models') }
      return { stronghold, store: client.getStore() }
    })()
    try { return await opening } catch (e) { opening = undefined; throw e }
  }
  // Serialize updates and save only after the encrypted snapshot is written.
  let pending = Promise.resolve()
  const mutate = (action: (v: Awaited<ReturnType<typeof vault>>) => Promise<void>) => {
    const result = pending.then(async () => { const v = await vault(); await action(v); await v.stronghold.save() })
    pending = result.catch(() => undefined); return result
  }
  return {
    async get(key) { await pending; const v = await vault(); const value = await v.store.get(key); return value ? new TextDecoder().decode(new Uint8Array(value)) : undefined },
    set(key, value) { return mutate(async v => { await v.store.insert(key, Array.from(new TextEncoder().encode(value))) }) },
    delete(key) { return mutate(async v => { await v.store.remove(key) }) },
  }
}
