import { writeFileSync } from 'node:fs'
const url = process.env.READER_UPDATE_URL, key = process.env.READER_UPDATER_PUBLIC_KEY
if (!url || !key || new URL(url).protocol !== 'https:') throw new Error('Signed updater builds require READER_UPDATE_URL (HTTPS) and READER_UPDATER_PUBLIC_KEY')
const path = process.argv[2]
if (!path) throw new Error('Usage: node scripts/updater-config.mjs <config.json>')
writeFileSync(path, JSON.stringify({ bundle: { createUpdaterArtifacts: true }, app: { security: { capabilities: ['default', { identifier: 'signed-updater', windows: ['main'], permissions: ['updater:default'] }] } } }, null, 2) + '\n')
