#!/usr/bin/env python3
"""Verify a reviewed release artifact without accessing current course workspaces."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--require-remote', action='store_true')
args = parser.parse_args()
root = args.directory.resolve()
sha = lambda data: hashlib.sha256(data).hexdigest()
build_bytes = (root / 'build-manifest.json').read_bytes()
expected = os.environ.get('EXPECTED_BUILD_SHA')
if expected and sha(build_bytes) != expected:
    raise SystemExit('Artifact differs from reviewed build-manifest hash')
build = json.loads(build_bytes)
manifest = json.loads((root / 'manifest.json').read_bytes())
lock = json.loads((root / 'release.lock.json').read_bytes())
rid = manifest['release_id']
if rid != build['release_id'] or rid != lock['release_id'] or build['validation'] != 'passed':
    raise SystemExit('Mixed release versions')
if os.environ.get('EXPECTED_RELEASE', rid) != rid:
    raise SystemExit('Unexpected release ID')
if manifest['manifestVersion'] != 3 or manifest['content_base'] != f'releases/{rid}/courses/':
    raise SystemExit('Unsupported or mutable content source')
if args.require_remote and (lock.get('mode') != 'remote' or any(
        r.get('git_status') != 'remote_verified' or not r.get('remote_proof_sha256') for r in lock['repositories'])):
    raise SystemExit('Publication requires a remotely verified release lock')
actual = set()
for path in root.rglob('*'):
    if path.is_symlink(): raise SystemExit('Artifact links forbidden')
    if path.is_file(): actual.add(path.relative_to(root).as_posix())
if actual != set(build['files']) | {'build-manifest.json'}:
    raise SystemExit('Unlisted or missing artifact files')
for name, item in build['files'].items():
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '.git' in p.parts or '\\' in name:
        raise SystemExit('Unsafe artifact path')
    data = (root / name).read_bytes()
    if len(data) != item['bytes'] or sha(data) != item['sha256']:
        raise SystemExit(f'Artifact hash mismatch: {name}')
if sha((root / 'release.lock.json').read_bytes()) != build['release_lock_sha256']:
    raise SystemExit('Release lock hash mismatch')
print(json.dumps({'status':'verified', 'release_id':rid, 'files':len(build['files']), 'mode':lock.get('mode')}))
