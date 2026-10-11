import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const native = fileURLToPath(new URL('../native/', import.meta.url))
const destination = fileURLToPath(new URL('../android/app/src/main/java/com/linjiang12/coursereader/', import.meta.url))
if (!existsSync(fileURLToPath(new URL('../android/app/build.gradle', import.meta.url)))) throw new Error('Run pnpm android:add first')
mkdirSync(destination, { recursive: true })
cpSync(native, destination, { recursive: true })
