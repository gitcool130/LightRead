#!/usr/bin/env node
// `tauri android init` 生成的工程 (src-tauri/gen/android, 不入库) 之上的补丁, CI 与本机构建都在 init 之后运行:
//   node scripts/patch-android-project.mjs [src-tauri/gen/android]
//
// 应用内更新 (src/services/updater.ts + src-tauri/android/MainActivity.kt) 需要:
//  1. 清单声明 REQUEST_INSTALL_PACKAGES, 否则无法拉起系统安装器、也无法申请「安装未知应用」;
//  2. FileProvider `${applicationId}.fileprovider` 能共享 cacheDir 下的文件。Tauri 模板自带该
//     provider 与 cache-path "."; 缺 cache-path 时补一条只覆盖 updates/ 的路径, 缺 provider 直接报错。
// 原生语音同时需要 Android 11+ TTS_SERVICE queries，并复制 MainActivity 及 NativeTtsBridge。
// 脚本是幂等的。
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL_PERMISSION = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />'
const TTS_QUERY = '    <intent>\n      <action android:name="android.intent.action.TTS_SERVICE" />\n    </intent>'

export function patchManifest(xml) {
  if (!/android:authorities="\$\{applicationId\}\.fileprovider"/.test(xml) || !xml.includes('androidx.core.content.FileProvider')) {
    throw new Error('AndroidManifest.xml 缺少 ${applicationId}.fileprovider 的 FileProvider, 应用内更新无法安装')
  }
  if (!xml.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    const anchor = xml.match(/^([ \t]*)<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/m)
    if (anchor) xml = xml.replace(anchor[0], `${anchor[0]}\n${anchor[1]}${INSTALL_PERMISSION}`)
    else {
      const open = xml.match(/<manifest\b[^>]*>/)
      if (!open) throw new Error('AndroidManifest.xml 缺少 <manifest>')
      xml = xml.replace(open[0], `${open[0]}\n    ${INSTALL_PERMISSION}`)
    }
  }
  // Android 11+ 的包可见性要求；已有安装权限也仍须检查原生语音查询。
  const queries = xml.match(/<queries\b[^>]*>[\s\S]*?<\/queries>/)
  if (queries?.[0].includes('android.intent.action.TTS_SERVICE')) return xml
  if (queries) return xml.replace(queries[0], queries[0].replace('</queries>', `${TTS_QUERY}\n  </queries>`))
  if (/<queries\s*\/>/.test(xml)) return xml.replace(/<queries\s*\/>/, `<queries>\n${TTS_QUERY}\n  </queries>`)
  if (!xml.includes('</manifest>')) throw new Error('AndroidManifest.xml 缺少 </manifest>')
  return xml.replace('</manifest>', `  <queries>\n${TTS_QUERY}\n  </queries>\n</manifest>`)
}

/** 所有版本都从可追踪源码复制桥接类，避免只复制 MainActivity 时漏掉依赖。 */
export function copyNativeSources(root) {
  const source = fileURLToPath(new URL('../src-tauri/android/', import.meta.url))
  const target = join(root, 'app/src/main/java/com/yzfly/lightread')
  mkdirSync(target, { recursive: true })
  for (const name of ['MainActivity.kt', 'NativeTtsBridge.kt']) copyFileSync(join(source, name), join(target, name))
}

export function patchFilePaths(xml) {
  // cache-path 覆盖整个缓存目录 (".") 或 updates/ 时无需改动
  if (/<cache-path\b[^>]*android:path="(\.|\.\/|updates\/?)"/.test(xml) || /<cache-path\b[^>]*\bpath="(\.|\.\/|updates\/?)"/.test(xml)) return xml
  if (!xml.includes('</paths>')) throw new Error('file_paths.xml 缺少 <paths>')
  return xml.replace('</paths>', '  <cache-path name="lightread_updates" path="updates/" />\n</paths>')
}

function main() {
  const root = process.argv[2] ?? 'src-tauri/gen/android'
  const manifestPath = join(root, 'app/src/main/AndroidManifest.xml')
  const pathsPath = join(root, 'app/src/main/res/xml/file_paths.xml')
  const manifest = readFileSync(manifestPath, 'utf8')
  const paths = readFileSync(pathsPath, 'utf8')
  const nextManifest = patchManifest(manifest)
  const nextPaths = patchFilePaths(paths)
  if (nextManifest !== manifest) writeFileSync(manifestPath, nextManifest)
  if (nextPaths !== paths) writeFileSync(pathsPath, nextPaths)
  copyNativeSources(root)
  console.log('Android 工程已就绪: 安装权限、原生语音查询、缓存共享路径与桥接源码已同步')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
