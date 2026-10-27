// 互传端到端: 本地 wrangler 起 sync-server (DEV_EXPOSE_CODE=1, 验证码随响应返回) + 内嵌最小 WebDAV,
// 多个浏览器上下文模拟多台设备. 设计见 docs/device-transfer.md.
// 前置: npm run build && npx vite preview --port 4186 --strictPort &
//   (换端口: E2E_BASE=http://localhost:4173/ ; 同步服务端口 E2E_API_PORT 默认 8796; WebDAV 端口 E2E_DAV_PORT 默认 8097)
// 覆盖:
//  账号: A、B 登录同一账号 → A 发文字 / 链接 / EPUB → B 在藏书页收到提醒 → 查看 → 导入 EPUB 并打开 → 删除文字 (A 也没了)
//  取件码: A 生成取件码 (二维码) → 未登录的手机 C 打开分享链接取件; 错码提示
//  WebDAV: 未登录的 D、E 配同一个 WebDAV → D 发文字 → E 收到 → E 删除
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'

const APP = (process.env.E2E_BASE ?? 'http://localhost:4186/').replace(/\/?$/, '/')
const API_PORT = Number(process.env.E2E_API_PORT ?? 8796)
const DAV_PORT = Number(process.env.E2E_DAV_PORT ?? 8097)
const API = `http://127.0.0.1:${API_PORT}`
const SHOTS = process.env.E2E_SHOTS ?? ''

// ---- 本地同步服务 ----
const persist = mkdtempSync(join(tmpdir(), 'lightread-transfer-api-'))
const wranglerArgs = ['-c', 'sync-server/wrangler.jsonc', '--persist-to', persist]
execFileSync('npx', ['wrangler', 'd1', 'execute', 'lightread-sync', '--local', ...wranglerArgs,
  '--file', 'sync-server/schema.sql'], { stdio: 'ignore' })
const server = spawn('npx', ['wrangler', 'dev', ...wranglerArgs, '--port', String(API_PORT),
  '--ip', '127.0.0.1', '--var', 'DEV_EXPOSE_CODE:1'], { stdio: 'ignore', detached: true })

// ---- 最小 WebDAV (同 e2e-sync.mjs, 另支持 DELETE) ----
const davRoot = mkdtempSync(join(tmpdir(), 'lightread-transfer-dav-'))
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,PUT,DELETE,MKCOL,PROPFIND,OPTIONS',
  'access-control-allow-headers': 'authorization,depth,content-type,user-agent,accept',
  'access-control-expose-headers': 'etag,content-length,last-modified',
}
const propEntry = (href, st) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${
  st.isDirectory() ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>'
}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
const dav = http.createServer((req, res) => {
  const send = (code, body = '') => { res.writeHead(code, cors); res.end(body) }
  if (req.method === 'OPTIONS') return send(204)
  if (req.headers.authorization !== 'Basic ' + Buffer.from('u:p').toString('base64')) return send(401)
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = join(davRoot, urlPath)
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const st = existsSync(file) ? statSync(file) : null
    switch (req.method) {
      case 'PROPFIND': {
        if (!st) return send(404)
        const base = urlPath.endsWith('/') || !st.isDirectory() ? urlPath : urlPath + '/'
        let xml = propEntry(base, st)
        if (st.isDirectory() && req.headers.depth !== '0') {
          for (const name of readdirSync(file)) {
            const cst = statSync(join(file, name))
            xml += propEntry(base + encodeURIComponent(name) + (cst.isDirectory() ? '/' : ''), cst)
          }
        }
        return send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`)
      }
      case 'MKCOL':
        if (st) return send(405)
        if (!existsSync(dirname(file))) return send(409)
        mkdirSync(file); return send(201)
      case 'PUT':
        if (!existsSync(dirname(file))) return send(409)
        writeFileSync(file, Buffer.concat(chunks)); return send(201)
      case 'DELETE':
        if (!st || st.isDirectory()) return send(404)
        unlinkSync(file); return send(204)
      case 'GET': case 'HEAD':
        if (!st || st.isDirectory()) return send(404)
        return send(200, req.method === 'GET' ? readFileSync(file) : '')
      default: return send(405)
    }
  })
})
await new Promise(r => dav.listen(DAV_PORT, '127.0.0.1', r))
mkdirSync(join(davRoot, 'dav'))

for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break } catch { /* 未就绪 */ }
  if (i > 120) throw new Error('本地同步服务启动超时')
  await new Promise(r => setTimeout(r, 500))
}

// ---- 测试书 (最小合法 EPUB) ----
const TMP = mkdtempSync(join(tmpdir(), 'lightread-transfer-'))
const BOOK_TITLE = '互传测试书'
const epubPath = join(TMP, 'transfer-test.epub')
writeFileSync(epubPath, Buffer.from(zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/package.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">transfer-e2e</dc:identifier><dc:title>${BOOK_TITLE}</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-06T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>`),
  'OEBPS/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>'),
  'OEBPS/chapter.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>正文</title></head><body><h1>第一章</h1><p>TRANSFER-E2E-BODY 互传正文。</p></body></html>'),
})))

const EMAIL = `transfer-${Date.now()}@example.com`
const TEXT = '互传端到端测试：一段要发到另一台设备的文字。'
const LINK = 'https://example.com/books/sample.epub'

const browser = await chromium.launch()
const errors = []
// transfer: 预先在「设置 → 功能」里开启互传 (默认关闭)
async function device(name, { viewport = { width: 1280, height: 800 }, settings, scheme = 'light', transfer = true } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, acceptDownloads: true })
  await context.addInitScript(([api, s, on]) => {
    localStorage.setItem('lightread-sync-api', api)
    const raw = localStorage.getItem('lightread-settings')
    const cur = raw ? JSON.parse(raw) : (s ?? {})
    if (on) cur.features = { ...(cur.features ?? {}), transfer: true }
    if (raw || s || on) localStorage.setItem('lightread-settings', JSON.stringify(cur))
  }, [API, settings ?? null, transfer])
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`))
  await page.goto(APP + '#/library', { waitUntil: 'networkidle' })
  return page
}

const listBooks = page => page.evaluate(() => new Promise((ok, err) => {
  const r = indexedDB.open('lightread')
  r.onerror = () => err(r.error)
  r.onsuccess = () => {
    const req = r.result.transaction('books').objectStore('books').getAll()
    req.onsuccess = () => { ok(req.result.map(({ file, cover, ...m }) => m)); r.result.close() }
  }
}))

async function login(page) {
  await page.goto(APP + '#/settings', { waitUntil: 'networkidle' })
  await page.getByRole('textbox', { name: /邮箱/ }).fill(EMAIL)
  const codeRes = page.waitForResponse(r => r.url().endsWith('/v1/auth/code'))
  await page.getByRole('button', { name: '发送验证码' }).click()
  const { devCode } = await (await codeRes).json()
  await page.getByRole('textbox', { name: /验证码/ }).fill(devCode)
  await page.locator('.conn-card', { hasText: EMAIL }).waitFor({ timeout: 10000 })
}

async function openTransfer(page, hash = '#/transfer') {
  await page.goto(APP + hash, { waitUntil: 'networkidle' })
  await page.locator('.transfer').waitFor({ timeout: 10000 })
}

async function sendText(page, text) {
  await page.getByRole('textbox', { name: '要发送的文字或链接' }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.xfer-item', { hasText: text }).first().waitFor({ timeout: 15000 })
}

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false })
}

let step = 0
const ok = msg => console.log(`✓ ${++step}. ${msg}`)
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

try {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })

  // ---------------- 功能开关: 默认关闭 ----------------
  const Z = await device('Z', { transfer: false })
  assert(await Z.locator('.sidebar .nav-item', { hasText: '互传' }).count() === 0, '默认关闭: 侧栏不应有「互传」')
  await openTransfer(Z)
  await Z.getByRole('button', { name: '开启互传' }).click()
  await Z.getByRole('button', { name: '取件码', exact: true }).waitFor()
  await Z.locator('.sidebar .nav-item', { hasText: '互传' }).waitFor()
  await Z.context().close()
  ok('互传默认关闭: 侧栏无入口, 互传页提示开启; 点「开启互传」后页面与侧栏入口出现')

  // ---------------- 轻阅账号 ----------------
  const A = await device('A')
  const B = await device('B')

  await openTransfer(A)
  await A.locator('.setup', { hasText: '登录后在设备间互传' }).waitFor()
  await shot(A, 'desktop-light-setup')
  ok('未登录: 互传页显示登录提示与「用取件码临时传」')

  await login(A)
  await login(B)
  // B 打开一次互传页: 登记设备, 记下已见
  await openTransfer(B)
  await openTransfer(A)
  await A.getByRole('button', { name: '发送到', exact: true }).click()
  await A.locator('.app-select-option', { hasText: 'Web' }).first().waitFor({ timeout: 10000 })
  await A.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  ok('A、B 登录同一账号; A 的目标设备列表里出现 B')

  await B.goto(APP + '#/library', { waitUntil: 'networkidle' })

  await sendText(A, TEXT)
  await sendText(A, LINK)
  await A.setInputFiles('input[data-transfer-file]', epubPath)
  await A.locator('.file-chip', { hasText: 'transfer-test.epub' }).waitFor()
  await A.getByRole('button', { name: '发送', exact: true }).click()
  await A.locator('.xfer-item[data-kind="file"]').waitFor({ timeout: 20000 })
  assert(await A.locator('.xfer-item.out').count() === 3, 'A 应有 3 条已发送')
  await shot(A, 'desktop-light-sent')
  ok('A 发出文字、链接、EPUB (文件带上传进度)')

  // B 在藏书页: 轮询 (30 s) 收到后弹出提醒
  const toastEl = B.locator('.toast', { hasText: /收到来自「.+」的 \d 条/ })
  await toastEl.waitFor({ timeout: 60000 })
  await toastEl.getByRole('button', { name: '查看' }).click()
  await B.waitForURL(/#\/transfer/)
  await B.locator('.xfer-item').nth(2).waitFor({ timeout: 10000 })
  assert(await B.locator('.xfer-item', { hasText: TEXT }).count() === 1, 'B 未收到文字')
  assert(await B.locator('.xfer-item[data-kind="link"]', { hasText: LINK }).count() === 1, 'B 未收到链接')
  assert(await B.locator('.xfer-item.out').count() === 0, 'B 收到的不应显示为已发送')
  ok('B 在藏书页收到「收到来自…的 N 条」提醒, 点「查看」打开互传页')

  await B.locator('.xfer-item[data-kind="link"]').getByRole('button', { name: '下载到藏书' }).waitFor()
  await B.locator('.xfer-item', { hasText: TEXT }).getByRole('button', { name: '复制' }).waitFor()
  await shot(B, 'desktop-light-received')

  await B.locator('.xfer-item[data-kind="file"]').getByRole('button', { name: '添加并打开' }).click()
  await B.waitForURL(/#\/read\//, { timeout: 20000 })
  const books = await listBooks(B)
  assert(books.length === 1 && books[0].title === BOOK_TITLE, `B 书库应有《${BOOK_TITLE}》: ${JSON.stringify(books.map(b => b.title))}`)
  await B.waitForFunction(() => [...document.querySelectorAll('foliate-view')].length > 0, null, { timeout: 15000 })
  ok('B 导入 EPUB 并在阅读器里打开')

  await openTransfer(B)
  await B.locator('.xfer-item', { hasText: TEXT }).getByRole('button', { name: '删除' }).click()
  await B.locator('.confirm-accept').click()
  await B.locator('.xfer-item', { hasText: TEXT }).waitFor({ state: 'detached', timeout: 10000 })
  await A.getByRole('button', { name: '刷新' }).click()
  await A.locator('.xfer-item', { hasText: TEXT }).waitFor({ state: 'detached', timeout: 10000 })
  assert(await A.locator('.xfer-item').count() === 2, 'A 应剩 2 条')
  ok('B 删除文字 → A 刷新后也消失')

  // 书卡片「发送到其他设备」
  await B.goto(APP + '#/library', { waitUntil: 'networkidle' })
  await B.locator('.book-card').first().hover()
  await B.locator('.book-card').first().locator('.meta-more').click()
  await B.locator('.book-card').first().getByRole('menuitem', { name: '发送到其他设备' }).click()
  await B.locator('.toast', { hasText: '已发送到我的其他设备' }).waitFor({ timeout: 15000 })
  await A.getByRole('button', { name: '刷新' }).click()
  await A.locator('.xfer-item:not(.out)[data-kind="file"]', { hasText: BOOK_TITLE }).waitFor({ timeout: 10000 })
  ok('书卡片「发送到其他设备」: A 收到 B 发来的书')

  // ---------------- 取件码 ----------------
  await A.getByRole('button', { name: '取件码', exact: true }).click()
  await A.locator('.drop-card').first().getByRole('textbox', { name: '要发送的文字或链接' }).fill('取件码临时内容')
  await A.getByRole('button', { name: '1 小时' }).click()
  await A.getByRole('button', { name: '生成取件码' }).click()
  const codeEl = A.locator('.drop-code')
  await codeEl.waitFor({ timeout: 10000 })
  const code = (await codeEl.innerText()).replace(/\D/g, '')
  assert(/^\d{6}$/.test(code), `取件码格式不对: ${code}`)
  assert(await A.locator('svg.qr path').count() === 1, '缺二维码')
  const link = await A.locator('.drop-link').innerText()
  assert(link.endsWith(`#/transfer?code=${code}`), `分享链接不对: ${link}`)
  await shot(A, 'desktop-light-drop')
  ok(`A 生成取件码 ${code} (二维码 + 分享链接)`)

  const C = await device('C', { viewport: { width: 390, height: 844 } })
  await C.goto(APP + `#/transfer?code=${code}`, { waitUntil: 'networkidle' })
  await C.locator('.xfer-item', { hasText: '取件码临时内容' }).waitFor({ timeout: 10000 })
  assert(await C.locator('.xfer-item', { hasText: '还可取 9 次' }).count() === 1, '应显示剩余次数')
  await shot(C, 'phone-light-drop-received')
  await C.getByRole('textbox', { name: '取件码' }).fill('000000')
  await C.getByRole('button', { name: '取件', exact: true }).click()
  await C.locator('.toast', { hasText: '没找到内容' }).waitFor({ timeout: 10000 })
  ok('未登录的手机 C 打开分享链接直接取件; 错码提示「没有找到」')

  // ---------------- WebDAV ----------------
  const davSettings = { webdavUrl: `http://127.0.0.1:${DAV_PORT}/dav`, webdavUser: 'u', webdavPass: 'p', webdavSyncAuto: false }
  const D = await device('D', { settings: davSettings, scheme: 'dark' })
  const E = await device('E', { settings: davSettings, viewport: { width: 390, height: 844 }, scheme: 'dark' })
  await openTransfer(E)
  await openTransfer(D)
  await sendText(D, '经 WebDAV 互传的文字')
  await shot(D, 'desktop-dark-webdav-sent')
  await E.getByRole('button', { name: '刷新' }).click()
  const davItem = E.locator('.xfer-item', { hasText: '经 WebDAV 互传的文字' })
  await davItem.waitFor({ timeout: 15000 })
  assert(existsSync(join(davRoot, 'dav/LightRead/transfer')), 'WebDAV 上应有 LightRead/transfer 目录')
  await shot(E, 'phone-dark-webdav')
  await davItem.getByRole('button', { name: '删除' }).click()
  await E.locator('.confirm-accept').click()
  await davItem.waitFor({ state: 'detached', timeout: 10000 })
  const left = readdirSync(join(davRoot, 'dav/LightRead/transfer')).filter(n => n.startsWith('item-'))
  assert(left.length === 0, `WebDAV 上应已删除条目: ${left}`)
  ok('未登录的 D、E 经同一个 WebDAV 互传文字, E 删除后 WebDAV 上也没了')

  if (errors.length) throw new Error('页面错误:\n' + errors.join('\n'))
  console.log(`\n全部 ${step} 步通过`)
} finally {
  await browser.close()
  dav.close()
  try { process.kill(-server.pid) } catch { /* 已退出 */ }
  rmSync(persist, { recursive: true, force: true })
  rmSync(davRoot, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
}
