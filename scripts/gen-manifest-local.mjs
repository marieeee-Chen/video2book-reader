/**
 * 本地课程仓 manifest 生成：不走 GitHub API，直接扫 public/courses/ 目录树。
 * 派生逻辑复用 packages/reader/src/content/derive.ts（与官方 gen-manifest 同一份实现）。
 * 用法：node scripts/gen-manifest-local.mjs   （在仓库根执行）
 * 产物：github-web/public/manifest.json（courses 相对路径 + categories 空，书架按目录分组）
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COURSES_DIR = join(ROOT, 'github-web', 'public', 'courses')
const OUT = join(ROOT, 'github-web', 'public', 'manifest.json')
const ARTIFACT_DIRS = new Set(['textbooks', 'notes', 'subtitles'])

const { deriveCourses } = await import('../packages/reader/src/content/derive.ts')

const entries = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p)
    else entries.push({ path: relative(COURSES_DIR, p), type: 'blob', size: s.size })
  }
}
walk(COURSES_DIR)

// 只保留三类产物目录内的文件，交给官方派生逻辑
const files = entries.filter(e => e.path.split('/').some(seg => ARTIFACT_DIRS.has(seg)))
const courses = deriveCourses(files, undefined, undefined)
const manifest = { generatedAt: new Date().toISOString(), source: 'local', courses, categories: [] }
writeFileSync(OUT, JSON.stringify(manifest, null, 2))
console.log(`manifest 写入 ${OUT}`)
console.log(`课程 ${courses.length} 门 | 教材 ${courses.reduce((a, c) => a + c.volumes.length, 0)} 册 | 笔记 ${courses.reduce((a, c) => a + c.notes.length, 0)} 篇 | 逐字稿 ${courses.reduce((a, c) => a + c.subtitles.length, 0)} 份`)
for (const c of courses) console.log(` - ${c.title} | ${c.publishPath} | 教材${c.volumes.length} 笔记${c.notes.length} 逐字稿${c.subtitles.length}`)
