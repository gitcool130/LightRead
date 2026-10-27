#!/usr/bin/env node
/**
 * 样式档位棘轮 (docs/design/style-convergence.md): 统计组件里没走令牌的裸值, 只许减少不许增加。
 *
 *   node scripts/check-style-tokens.mjs            # 与基线比较, 任一项变多就失败
 *   node scripts/check-style-tokens.mjs --update   # 替换掉一批裸值后, 把更低的数字写回基线
 *
 * 统计范围 src/**\/*.{vue,css}, 不含 src/vendor 与令牌定义文件 (styles/main.css)。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const BASELINE = join(ROOT, 'scripts/style-tokens-baseline.json')
const SKIP = new Set(['src/vendor', 'src/styles/main.css', 'src/mobile/styles/main.css'])

const RULES = {
  /** font-size 写死 px (阅读正文字号来自用户设置, 走变量, 不计入) */
  fontSizePx: /font-size:\s*\d+(?:\.\d+)?px/g,
  /** font-weight 不在 400 / 500 / 600 */
  fontWeightOff: /font-weight:\s*(?!400\b|500\b|600\b|var\()\d+/g,
  /** border-radius 写死 px (胶囊 999px 与 50% 圆形除外) */
  radiusPx: /border-radius:\s*(?!999px)(?:\d+(?:\.\d+)?px)/g,
  /** box-shadow 不经令牌 (none 除外) */
  shadowRaw: /box-shadow:\s*(?!\s|none\b|var\(|inherit\b)[^;]+/g,
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const rel = relative(ROOT, path)
    if (SKIP.has(rel)) continue
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(vue|css)$/.test(name)) out.push(path)
  }
  return out
}

const counts = Object.fromEntries(Object.keys(RULES).map(k => [k, 0]))
const perFile = {}
for (const file of walk(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8')
  // .vue 只看 <style>; .css 全文
  const css = file.endsWith('.vue') ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') : text
  for (const [key, re] of Object.entries(RULES)) {
    const n = css.match(re)?.length ?? 0
    counts[key] += n
    if (n) (perFile[relative(ROOT, file)] ??= {})[key] = n
  }
}

let baseline = {}
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
} catch { /* 首次运行 */ }

if (process.argv.includes('--update')) {
  const next = Object.fromEntries(Object.keys(RULES).map(k => [k, baseline[k] == null ? counts[k] : Math.min(baseline[k], counts[k])]))
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n')
  console.log('基线已更新:', next)
  process.exit(0)
}

let failed = false
for (const key of Object.keys(RULES)) {
  const base = baseline[key]
  const mark = base == null ? '(无基线)' : counts[key] > base ? `✗ 比基线多 ${counts[key] - base}` : counts[key] < base ? `↓ 少了 ${base - counts[key]}, 可 --update` : '='
  if (base != null && counts[key] > base) failed = true
  console.log(`${key.padEnd(14)} ${String(counts[key]).padStart(5)} / 基线 ${base ?? '-'}  ${mark}`)
}
if (failed) {
  console.error('\n新增了裸值。请改用 main.css 里的令牌 (--fs-* / --fw-* / --radius-* / --shadow-*)。各文件计数:')
  for (const [file, c] of Object.entries(perFile)) console.error(' ', file, JSON.stringify(c))
  process.exit(1)
}
