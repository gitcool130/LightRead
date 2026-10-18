// Reproducible version-only completion of the already published immutable tag.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
assert.equal(git('rev-parse', 'HEAD'), '1f65e15f447767d01ede13638dcc8d6df4724a0f')
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '')
const files = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']
for (const file of files) {
  let text = readFileSync(file, 'utf8')
  if (file.endsWith('.json')) {
    const data = JSON.parse(text)
    assert.equal(data.version, '1.19.4')
    data.version = '1.20.0'
    if (file === 'package-lock.json') {
      assert.equal(data.packages[''].version, '1.19.4')
      data.packages[''].version = '1.20.0'
    }
    const matches = [...text.matchAll(/"version": "1\.19\.4"/g)]
    assert.equal(matches.length, file === 'package-lock.json' ? 2 : 1)
    text = text.replaceAll('"version": "1.19.4"', '"version": "1.20.0"')
  } else {
    const pattern = /(name = "lightread"\r?\nversion = ")1\.19\.4(")/
    assert.match(text, pattern)
    text = text.replace(pattern, '$11.20.0$2')
  }
  writeFileSync(file, text)
}
assert.deepEqual(git('diff', '--name-only').split('\n').sort(), files.sort())
// Audit every changed line: no application behavior, dependency or identity changes.
const patch = git('diff', '--no-ext-diff', '--no-color')
for (const line of patch.split('\n')) {
  if (/^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)) {
    assert.match(line, /^[+-]\s*(?:"version": "1\.(?:19\.4|20\.0)",?|version = "1\.(?:19\.4|20\.0)")$/)
  }
}
writeFileSync('desktop-version.patch', patch + '\n')
console.log('Frozen v1.20.0 source prepared with version metadata only; application code unchanged.')
