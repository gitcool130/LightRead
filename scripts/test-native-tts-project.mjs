import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyNativeSources, patchManifest } from './patch-android-project.mjs'

const provider = '<provider android:name="androidx.core.content.FileProvider" android:authorities="${applicationId}.fileprovider" />'
const manifest = queries => `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />${queries}<application>${provider}</application></manifest>`

test('Android speech service stays visible when the updater manifest is already patched', () => {
  for (const queries of ['', '<queries />', '<queries><package android:name="org.example" /></queries>']) {
    const patched = patchManifest(manifest(queries))
    assert.equal((patched.match(/android.intent.action.TTS_SERVICE/g) ?? []).length, 1)
    assert.match(patched, /<queries>[\s\S]*<intent>[\s\S]*android.intent.action.TTS_SERVICE[\s\S]*<\/intent>[\s\S]*<\/queries>/)
    assert.equal(patchManifest(patched), patched)
    if (queries.includes('org.example')) assert.ok(patched.includes('org.example'))
  }
})

test('an existing speech service query is preserved exactly', () => {
  const xml = manifest('<queries><intent><action android:name="android.intent.action.TTS_SERVICE" /></intent></queries>')
  assert.equal(patchManifest(xml), xml)
})

test('generated Android sources include both the activity and its speech bridge', () => {
  const root = mkdtempSync(join(tmpdir(), 'lightread-native-tts-project-'))
  try {
    copyNativeSources(root)
    copyNativeSources(root)
    for (const name of ['MainActivity.kt', 'NativeTtsBridge.kt']) {
      assert.equal(readFileSync(join(root, 'app/src/main/java/com/yzfly/lightread', name), 'utf8'),
        readFileSync(new URL(`../src-tauri/android/${name}`, import.meta.url), 'utf8'))
    }
  } finally { rmSync(root, { recursive: true }) }
})
