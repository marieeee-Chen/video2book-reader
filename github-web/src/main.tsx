import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@app/reader/styles.css'
import 'katex/dist/katex.min.css'
import '../../packages/app/src/reading/app.css'
import './pwa.css'

import { App } from './App.tsx'
import { registerOfflineShell } from '../../packages/app/src/reading/offline.ts'
registerOfflineShell()

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
