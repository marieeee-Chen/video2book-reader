// Optional native acceptance content. Only bytes from a sealed release enter the native bundle.
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const source = process.env.READER_DEMO_RELEASE
if (source) {
  const root = resolve(source), dist = resolve(process.argv[2] || 'dist')
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const safe = path => path && !path.startsWith('/') && !/[\\?#]/.test(path) && path.split('/').every(p => p && p !== '..' && p !== '.')
  const bytes = readFileSync(join(root, 'build-manifest.json')), seal = JSON.parse(bytes)
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json')))
  if (manifest.manifestVersion !== 3 || !/^[\w.-]+$/.test(manifest.release_id) || seal.release_id !== manifest.release_id || manifest.content_base !== `releases/${manifest.release_id}/courses/`) throw Error('A sealed v3 release is required')
  const actual = []
  function walk(folder) {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw Error('Release symlinks are forbidden')
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) actual.push(relative(root, path).replaceAll('\\', '/'))
      else throw Error('Unsupported release file')
    }
  }
  walk(root)
  const expected = Object.keys(seal.files).sort()
  if (JSON.stringify(actual.filter(n => n !== 'build-manifest.json').sort()) !== JSON.stringify(expected)) throw Error('Release inventory changed')
  for (const name of expected) {
    if (!safe(name)) throw Error('Unsafe sealed path')
    const data = readFileSync(join(root, name)), item = seal.files[name]
    if (data.length !== item.bytes || sha(data) !== item.sha256) throw Error('Release SHA mismatch: ' + name)
  }
  const target = join(dist, 'demo'), temp = join(dist, '.demo-' + randomUUID())
  mkdirSync(temp, { recursive: true })
  try {
    const files = {}
    for (const name of expected.filter(n => n.startsWith('courses/') || n === 'manifest.json' || n === 'release.lock.json')) {
      const destination = name.startsWith('courses/') ? `releases/${manifest.release_id}/${name}` : name
      const path = join(temp, destination)
      mkdirSync(resolve(path, '..'), { recursive: true })
      writeFileSync(path, readFileSync(join(root, name)))
      files[destination] = seal.files[name]
    }
    writeFileSync(join(temp, 'staged-content.json'), JSON.stringify({ release_id: manifest.release_id, source_build_sha256: sha(bytes), files }, null, 2) + '\n')
    rmSync(target, { force: true, recursive: true }); renameSync(temp, target)
    console.log(`Bundled verified demo ${manifest.release_id}: ${Object.keys(files).length} files`)
  } finally { rmSync(temp, { force: true, recursive: true }) }
}
