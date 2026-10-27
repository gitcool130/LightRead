#!/usr/bin/env node
/**
 * 发布关于页的微信读者群二维码 (微信群码 7 天过期, 不随应用打包):
 * 上传带内容哈希的图片与 community.json 到 R2 桶 lightread-assets 的 community/v1/,
 * 应用经 https://lightread-assets.jiangshu.ai/community/v1/community.json 读取 (src/services/aboutLinks.ts)。
 *
 *   node scripts/publish-community.mjs <二维码.png> --expires 2026-11-03 [--name "LightRead 读者群"] [--dry-run]
 *
 * --expires 是二维码上写的「X 月 X 日前有效」那一天 (北京时间零点起不再显示)。
 * 图片请先裁到只剩二维码 (界面显示 160px, 带标题的整图缩小后不好扫)。
 * 需要 CLOUDFLARE_API_TOKEN (可用 ~/.config/tokenssh-ai/cloudflare-workers-token)。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BUCKET = 'lightread-assets'
const PREFIX = 'community/v1/'
const BASE = 'https://lightread-assets.jiangshu.ai/' + PREFIX

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const imageArg = args.find((a, i) => !a.startsWith('--') && !['--expires', '--name'].includes(args[i - 1]))
const image = imageArg && resolve(imageArg)
const expires = flag('--expires')
const name = flag('--name') ?? 'LightRead 读者群'
const dryRun = args.includes('--dry-run')

if (!image || !/^\d{4}-\d{2}-\d{2}$/.test(expires ?? '')) {
  console.error('用法: node scripts/publish-community.mjs <二维码.png> --expires YYYY-MM-DD [--name 群名] [--dry-run]')
  process.exit(1)
}
const bytes = readFileSync(image)
if (bytes.subarray(1, 4).toString() !== 'PNG') {
  console.error('只接受 PNG 图片')
  process.exit(1)
}
const expiresAt = `${expires}T00:00:00+08:00`
if (Date.parse(expiresAt) <= Date.now()) {
  console.error(`过期时间 ${expiresAt} 已经过去`)
  process.exit(1)
}

const hash = createHash('sha256').update(bytes).digest('hex')
const imageKey = `${PREFIX}wechat-group-${hash.slice(0, 8)}.png`
const manifest = {
  version: 1,
  updatedAt: new Date().toISOString(),
  wechatGroup: { name, image: BASE + imageKey.slice(PREFIX.length), expiresAt, sha256: hash },
}
const dir = mkdtempSync(join(tmpdir(), 'lightread-community-'))
const manifestPath = join(dir, 'community.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))

function put(key, file, contentType, cacheControl) {
  const cmd = ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', contentType, '--cache-control', cacheControl, '--remote']
  if (dryRun) return console.log('[dry-run] npx', cmd.join(' '))
  // 在 sync-server/ 下运行: 根目录构建会留下 .wrangler/deploy/config.json 干扰 wrangler
  execFileSync('npx', cmd, { stdio: 'inherit', cwd: new URL('../sync-server/', import.meta.url) })
}

// 图片先传 (地址带哈希, 可长期缓存), 清单后传, 应用不会读到指向不存在图片的清单
put(imageKey, image, 'image/png', 'public, max-age=31536000, immutable')
put(`${PREFIX}community.json`, manifestPath, 'application/json', 'public, max-age=300')

if (!dryRun) {
  const res = await fetch(`${BASE}community.json?verify=${Date.now()}`)
  const live = await res.json()
  if (live.wechatGroup?.image !== manifest.wechatGroup.image) throw new Error('线上 community.json 与刚上传的不一致 (可能是缓存, 5 分钟后再查)')
  const img = Buffer.from(await (await fetch(manifest.wechatGroup.image)).arrayBuffer())
  if (createHash('sha256').update(img).digest('hex') !== hash) throw new Error('线上图片校验失败')
  console.log('已发布并回读校验:', BASE + 'community.json')
}
