import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const mobileUrl = new URL('../src/mobile/services/updater.ts', import.meta.url).href
const desktopUrl = new URL('../src/services/updater.ts', import.meta.url).href
const store = new Map(), calls = []
globalThis.__APP_VERSION__ = '2.0.0'
globalThis.__mobileUpdateFetch = async url => { calls.push(url); return { json: async () => globalThis.__mobileReleases } }
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
const hook = registerHooks({ resolve(specifier, context, next) {
  if ([mobileUrl, desktopUrl].includes(context.parentURL)) {
    let code
    if (specifier.endsWith('/storage/types')) code = 'export const isTauri = () => true'
    if (specifier.endsWith('/net')) code = 'export const fetchRemote = (...args) => globalThis.__mobileUpdateFetch(...args); export const remoteProxy = () => ""'
    if (specifier.endsWith('/i18n')) code = 'export const t = key => key'
    if (specifier === './toast') code = 'export const toast = () => {}'
    if (code) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(code)}` }
  }
  return next(specifier, context)
} })
const mobile = await import(mobileUrl), desktop = await import(desktopUrl)
after(() => hook.deregister())
const release = (tag, names = [`LightRead_${tag}_android_arm64.apk`, 'SHA256SUMS']) => ({
  tag_name: tag, assets: names.map(name => ({ name, browser_download_url: `https://github.com/yzfly/LightRead/releases/download/${tag}/${name}`, size: 100 })),
  body: 'notes', html_url: `https://github.com/yzfly/LightRead/releases/tag/${tag}`,
})
beforeEach(() => { store.clear(); calls.length = 0 })
test('App selects its newest complete stable release, independently of desktop latest', () => {
  const list = [release('v1.20.0'), release('app-v2.0.1'), release('app-v2.0.0'), release('v3.0.0', ['LightRead_3.0.0_x64-setup.exe', 'SHA256SUMS']),
    { ...release('app-v2.0.9'), draft: true }, { ...release('app-v2.0.8'), prerelease: true },
    release('app-v2.0.7', ['SHA256SUMS']), release('app-v2.0.6', ['LightRead_app-v2.0.6_android_arm64.apk']),
    release('reader-fonts-20261018')]
  for (const parse of [mobile.parseGithubReleases, mobile.parseMirrorReleases]) {
    const info = parse(list)
    assert.equal(info.version, '2.0.1'); assert.equal(info.hasUpdate, true)
    assert.ok(info.assets[0].url.includes('/app-v2.0.1/'))
    assert.equal(parse(null), null)
  }
})
test('frozen desktop mirror parser ignores App tags', () => {
  assert.equal(desktop.parseMirrorReleases([release('app-v2.0.1'), release('v1.20.0')]).version, '1.20.0')
  assert.equal(desktop.parseMirrorReleases([release('app-v2.0.1')]), null)
})
test('App can read legacy v1 Android releases without claiming an upgrade', () => {
  const info = mobile.parseGithubReleases([release('v1.20.0')])
  assert.equal(info.version, '1.20.0'); assert.equal(info.hasUpdate, false)
})
test('App fetches release list, ignores desktop cache and recalculates installed version', async () => {
  store.set('lightread-update-check', JSON.stringify({ at: Date.now(), info: { version: '99.0.0' } }))
  globalThis.__mobileReleases = [release('app-v2.0.0')]
  const info = await mobile.checkUpdate(true)
  assert.equal(info.hasUpdate, false)
  assert.match(calls[0], /releases\?per_page=100$/)
  store.set('lightread-mobile-update-check', JSON.stringify({ at: Date.now(), info: { ...info, hasUpdate: true } }))
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Android' } })
  assert.equal((await mobile.checkUpdate()).hasUpdate, false)
  assert.equal(calls.length, 1)
})
test('App tags survive checksum/download mirror routing exactly', () => {
  const url = release('app-v2.0.1').assets[0].browser_download_url
  assert.equal(mobile.parseReleaseDownloadUrl(url).tag, 'app-v2.0.1')
  assert.ok(mobile.downloadPlan(url).every(step => step.url.includes('/app-v2.0.1/')))
  assert.equal(mobile.compareVersions('app-v2.0.1', 'v2.0.0'), 1)
})
test('release gates accept App platform tags and reject them for desktop', () => {
  const { version } = JSON.parse(readFileSync(new URL('../src-tauri/tauri.android.conf.json', import.meta.url), 'utf8'))
  execFileSync(process.execPath, ['scripts/check-release.mjs', '--platform', 'android', '--tag', `app-v${version}`])
  assert.throws(() => execFileSync(process.execPath, ['scripts/check-release.mjs', '--platform', 'android', '--tag', `v${version}`], { stdio: 'pipe' }))
  assert.throws(() => execFileSync(process.execPath, ['scripts/check-release.mjs', '--platform', 'desktop', '--tag', `app-v${version}`], { stdio: 'pipe' }))
})

// v2.2.0–v2.2.5 曾统一用 vX.Y.Z 发全平台; 已安装的 App 仍要能读这些带 APK 的旧版本
test('App still reads legacy unified v2.2.x Android releases from both sources', () => {
  for (const parse of [mobile.parseGithubReleases, mobile.parseMirrorReleases]) {
    const info = parse([release('v1.20.1'), release('app-v2.0.0'), release('v2.0.1'),
      { ...release('v3.0.0'), prerelease: true }, release('v4.0.0', ['SHA256SUMS'])])
    assert.equal(info.version, '2.0.1')
    assert.equal(info.hasUpdate, true)
    assert.ok(info.assets[0].url.includes('/v2.0.1/'))
  }
})
