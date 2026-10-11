import { invoke } from '@tauri-apps/api/core'
import { createLocalDirSource } from '../../../packages/reader/src/content/local-source.ts'
export async function chooseLocalContent() {
  const handle = await invoke<string | null>('select_directory')
  if (!handle) return undefined
  const source = createLocalDirSource(async (name, signal) => {
    signal?.throwIfAborted()
    const data = await invoke<number[]>('read_selected_file', { handle, name })
    signal?.throwIfAborted(); return new Uint8Array(data)
  })
  await source.listCourses()
  return source
}
