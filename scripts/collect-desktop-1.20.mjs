import assert from 'node:assert/strict'
import { readdirSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const [id, target = ''] = process.argv.slice(2)
assert.ok(['mac-arm64', 'mac-x64', 'windows', 'linux'].includes(id))
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const base = join('src-tauri/target', target, 'release')
const bundle = join(base, 'bundle')
const out = 'desktop-assets'
mkdirSync(out, { recursive: true })
const expected = id === 'linux' ? ['LightRead_1.20.0_amd64.AppImage', 'LightRead_1.20.0_amd64.deb', 'LightRead-1.20.0-1.x86_64.rpm'] : id === 'windows' ? ['LightRead_1.20.0_x64-setup.exe'] : [`LightRead_1.20.0_${id === 'mac-arm64' ? 'aarch64' : 'x64'}.dmg`]
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]) }
const found = walk(bundle)
for (const name of expected) {
  const matches = found.filter(p => basename(p) === name)
  assert.equal(matches.length, 1, `Missing or duplicate ${name}`)
  copyFileSync(matches[0], join(out, name))
}
let nativeVersion
if (id.startsWith('mac-')) {
  nativeVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(bundle, 'macos/LightRead.app/Contents/Info.plist')])
  const arch = id === 'mac-arm64' ? 'aarch64' : 'x64'
  const file = run('file', [join(bundle, 'macos/LightRead.app/Contents/MacOS/lightread')])
  assert.ok(file.includes(arch === 'aarch64' ? 'arm64' : 'x86_64'), file)
  run('tar', ['-czf', join(out, `LightRead_${arch}.app.tar.gz`), '-C', join(bundle, 'macos'), 'LightRead.app'])
} else if (id === 'linux') {
  nativeVersion = run('dpkg-deb', ['-f', join(out, expected[1]), 'Version'])
  assert.equal(run('dpkg-deb', ['-f', join(out, expected[1]), 'Architecture']), 'amd64')
  assert.equal(run('rpm', ['-qp', '--qf', '%{VERSION}-%{ARCH}', join(out, expected[2])]), '1.20.0-x86_64')
} else {
  const exe = join(base, 'lightread.exe').replaceAll("'", "''")
  nativeVersion = run('pwsh', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`])
}
assert.match(nativeVersion, /^1\.20\.0(?:\.0)?$/)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const assets = Object.fromEntries(readdirSync(out).map(name => [name, hash(join(out, name))]))
writeFileSync(join(out, `desktop-${id}.build.json`), JSON.stringify({ tag: 'v1.20.0', commit: run('git', ['rev-parse', 'HEAD']), workflowCommit: process.env.RELEASE_WORKFLOW_SHA, nativeVersion, versionPatchSha256: hash('desktop-version.patch'), assets }, null, 2) + '\n')
copyFileSync('desktop-version.patch', join(out, 'desktop-version.patch'))
console.log(JSON.stringify({ id, nativeVersion, assets }, null, 2))
