// 书单推荐 + 待找条目 + 分享/导入 端到端 (网络全部 mock, 见 docs/booklists.md).
// 先构建并起预览 (默认 http://localhost:4173, E2E_BASE 可改). SHOTS_DIR=目录 时额外保存桌面/手机、浅色/深色截图.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { strToU8, zipSync } from 'fflate'

const base = process.env.E2E_BASE ?? 'http://localhost:4173'
const shots = process.env.SHOTS_DIR
if (shots) mkdirSync(shots, { recursive: true })

// 用自带的推荐书单走主流程: 找其中一本 (古登堡有的公版书) 下载, 再整单加入我的书单
const LIST_ID = 'western-literature-pd'
const BOOK = { title: 'Pride and Prejudice', author: 'Jane Austen' }
const dataDir = new URL('../src/data/booklists/', import.meta.url).pathname
const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8'))
const list = JSON.parse(readFileSync(join(dataDir, `${LIST_ID}.json`), 'utf8'))
assert.ok(list.books.some(b => b.title === BOOK.title && b.author === BOOK.author), `${LIST_ID} contains ${BOOK.title}`)
const bookIndex = list.books.findIndex(b => b.title === BOOK.title)

function epubBytes(title, author) {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${title}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    'nav.xhtml': strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>'),
    'c1.xhtml': strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>Chapter one.</p></body></html>`),
  }, { level: 0 })
}

const gutenbergFeed = (title, author) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/"><id>search</id><title>Gutenberg</title>
<entry><id>urn:gutenberg:1342</id><title>${title}</title><author><name>Austen, Jane</name></author><updated>2026-01-01T00:00:00Z</updated>
<link rel="http://opds-spec.org/acquisition" href="https://www.gutenberg.org/ebooks/1342.epub3.images" type="application/epub+zip"/></entry></feed>`

const errors = []
let remoteIndex = null // null = 远程不可用 (404), 用自带书单
const searches = []

const browser = await chromium.launch()

// booklists: 预先在「设置 → 功能」里开启书单推荐 (默认关闭)
async function newPage(viewport = { width: 1280, height: 900 }, { booklists = true } = {}) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(on => {
    window.__opened = []
    window.open = url => { window.__opened.push(url); return null }
    if (on) {
      const s = JSON.parse(localStorage.getItem('lightread-settings') || '{}')
      s.features = { ...(s.features ?? {}), recommendedBooklists: true }
      localStorage.setItem('lightread-settings', JSON.stringify(s))
    }
  }, booklists)
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (url.startsWith(base + '/')) return route.continue()
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (url.startsWith('https://raw.githubusercontent.com/yzfly/LightRead/main/src/data/booklists/')) {
      if (!remoteIndex) return route.fulfill({ status: 404, body: 'not found' })
      if (url.endsWith('/index.json')) return json(remoteIndex)
      if (url.endsWith('/e2e-remote-list.json')) {
        return json({
          id: 'e2e-remote-list', title: '远程新书单', description: '远程更新带来的书单', curator: '测试', tags: ['测试'],
          updated: remoteIndex.updated, source: { name: '轻阅编辑部', url: 'https://github.com/yzfly/LightRead', license: 'CC0-1.0' },
          books: [{ title: 'Walden', author: 'Henry David Thoreau', year: 1854 }],
        })
      }
      return route.fulfill({ status: 404, body: 'not found' })
    }
    if (url.includes('gutenberg.org/ebooks/search.opds')) {
      searches.push(decodeURIComponent(new URL(url).searchParams.get('query') ?? ''))
      return route.fulfill({ contentType: 'application/atom+xml', body: gutenbergFeed(BOOK.title, BOOK.author) })
    }
    if (url.includes('gutenberg.org/ebooks/1342')) {
      return route.fulfill({ contentType: 'application/epub+zip', body: Buffer.from(epubBytes(BOOK.title, BOOK.author)) })
    }
    if (url.includes('api.github.com/repos/')) return json({ tree: [], truncated: false })
    if (url.includes('archive.org/advancedsearch.php')) return json({ response: { docs: [] } })
    return route.abort()
  })
  return { context, page }
}

async function setTheme(page, theme) {
  await page.evaluate(theme => {
    const s = JSON.parse(localStorage.getItem('lightread-settings') || '{}')
    s.appearance = theme
    localStorage.setItem('lightread-settings', JSON.stringify(s))
  }, theme)
  await page.reload()
}

const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }) }

try {
  // ---- 默认关闭: 书源页没有「书单推荐」, 也不拉远程书单; 在设置 → 功能里打开后出现 ----
  {
    const { context, page } = await newPage(undefined, { booklists: false })
    const curatedFetches = []
    page.on('request', r => { if (r.url().includes('/src/data/booklists/')) curatedFetches.push(r.url()) })
    await page.goto(base + '/#/catalogs')
    await page.locator('.uni-section').waitFor()
    await page.waitForTimeout(800)
    assert.equal(await page.locator('.curated-section').count(), 0, 'curated section hidden when the feature is off')
    assert.deepEqual(curatedFetches, [], 'no remote booklist fetch when the feature is off')
    await page.goto(base + '/#/settings')
    await page.locator('#settings-features').getByRole('switch', { name: /书单推荐/ }).check()
    await page.waitForTimeout(500)
    await page.goto(base + '/#/catalogs')
    await page.locator('.curated-section').getByRole('heading', { name: '书单推荐' }).waitFor()
    await context.close()
  }

  const { context, page } = await newPage()
  await page.goto(base + '/#/catalogs')

  // ---- 书单推荐分区: 自带书单全部显示, 位于统一搜书之后、书库与目录之前 ----
  const section = page.locator('.curated-section')
  await section.getByRole('heading', { name: '书单推荐' }).waitFor()
  assert.equal(await section.locator('.curated-card').count(), index.lists.length, 'all bundled lists are shown')
  const order = await page.evaluate(() => [...document.querySelectorAll('.uni-section, .curated-section, .cat-section h2')]
    .map(el => el.classList.contains('uni-section') ? 'uni' : el.classList.contains('curated-section') ? 'curated' : el.textContent))
  assert.deepEqual(order.slice(0, 3), ['uni', 'curated', '书单推荐'])
  assert.equal(order[3], '书源', 'curated section sits right before the sources section')
  await shot(page, 'catalog-desktop-light')

  // ---- 打开书单详情 ----
  const listTitle = list.title
  await section.locator('.curated-card').filter({ hasText: listTitle }).click()
  await page.getByRole('heading', { name: listTitle, level: 1 }).waitFor()
  assert.equal(await page.locator('.curated-book').count(), list.books.length)
  assert.equal(await page.locator('.uni-section').isVisible(), false, 'home sections hidden in the detail view')
  const row = page.locator('.curated-book').nth(bookIndex)
  // 豆瓣: 只链出
  await row.getByRole('button', { name: '豆瓣查看' }).click()
  const doubanUrl = (await page.evaluate(() => window.__opened)).at(-1)
  assert.ok(doubanUrl.startsWith('https://search.douban.com/book/subject_search?search_text='), doubanUrl)
  assert.equal(new URL(doubanUrl).searchParams.get('search_text'), `${BOOK.title} ${BOOK.author}`)

  // ---- 找书: 统一搜书结果显示在这本书下面, 下载后变成「已在藏书」 ----
  await row.getByRole('button', { name: '找书', exact: true }).click()
  const found = row.locator('.curated-find .uni-group').filter({ hasText: '古登堡' })
  await found.getByText(BOOK.title, { exact: true }).waitFor()
  assert.equal(searches.at(-1), `${BOOK.title} ${BOOK.author}`, 'search query is title + author')
  await shot(page, 'curated-find-desktop-light')
  await found.getByRole('button', { name: '下载 EPUB', exact: true }).first().click()
  await page.getByText(/成功导入 1 本|已添加 1 本/).first().waitFor({ timeout: 15000 })
  await row.getByText('已在藏书', { exact: true }).waitFor()
  await row.getByRole('button', { name: '打开', exact: true }).waitFor()
  await page.locator('.curated-meta').getByText('已在藏书 1 本').waitFor()
  await row.getByRole('button', { name: '收起结果' }).click()
  assert.equal(await row.locator('.curated-find .uni-results').count(), 0, 'results moved back to the search card')

  // ---- 全部加入我的书单 ----
  await page.getByRole('button', { name: '全部加入我的书单' }).click()
  const wantedCount = list.books.length - 1
  await page.getByText(`已加入书单「${listTitle}」：1 本已在藏书，${wantedCount} 本待找`).waitFor()
  await shot(page, 'curated-detail-desktop-light')
  // 再加一次不重复
  await page.getByRole('button', { name: '全部加入我的书单' }).click()
  await page.getByText(`书单「${listTitle}」里已经有这些书了`).waitFor()
  await page.getByRole('button', { name: '查看', exact: true }).first().click()

  // ---- 藏书页: 书单里 1 本书 + 待找条目 ----
  await page.waitForURL(/#\/library/)
  await page.locator('.booklist-chip.active').filter({ hasText: listTitle }).waitFor()
  await page.locator('.book-card').filter({ hasText: BOOK.title }).waitFor()
  assert.equal(await page.locator('.book-card').count(), 1)
  const panel = page.locator('.wanted-panel')
  await panel.getByRole('heading', { name: new RegExp(`待找\\s*${wantedCount}`) }).waitFor()
  assert.equal(await panel.locator('.wanted-card').count(), wantedCount)
  // 手动添加待找的书
  await panel.getByRole('button', { name: '添加待找的书' }).click()
  await panel.getByRole('textbox', { name: '书名' }).fill('Walden')
  await panel.getByRole('textbox', { name: '作者（可选）' }).fill('Henry David Thoreau')
  await panel.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByText('已添加《Walden》').waitFor()
  await panel.getByRole('button', { name: '取消' }).click()
  assert.equal(await panel.locator('.wanted-card').count(), wantedCount + 1)
  // 已在藏书的书手动添加: 直接归入书单
  await panel.getByRole('button', { name: '添加待找的书' }).click()
  await panel.getByRole('textbox', { name: '书名' }).fill(BOOK.title)
  await panel.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByText(/书单里已经有这本书了|已在藏书里/).first().waitFor()
  await panel.getByRole('button', { name: '取消' }).click()
  await shot(page, 'library-wanted-desktop-light')

  // ---- 分享: 书单文件 + 纯文本 ----
  await page.locator('.booklist-more').click()
  await page.locator('.booklist-heading').getByRole('menuitem', { name: '分享书单' }).click()
  const dialog = page.getByRole('dialog', { name: `分享「${listTitle}」` })
  const json = await dialog.locator('textarea').inputValue()
  const share = JSON.parse(json)
  assert.equal(share.format, 'org.lightread.booklist')
  assert.equal(share.name, listTitle)
  assert.equal(share.books.length, list.books.length + 1)
  assert.ok(share.books.some(b => b.title === 'Walden'))
  await dialog.getByRole('button', { name: '纯文本' }).click()
  const text = await dialog.locator('textarea').inputValue()
  assert.match(text, new RegExp(`^# ${listTitle}`))
  assert.match(text, /\n1\. /)
  await shot(page, 'share-dialog-desktop-light')
  await dialog.getByRole('button', { name: '关闭' }).click()

  // ---- 待找条目「找书」: 跳到书源页并预填搜索 ----
  await panel.locator('.wanted-card').filter({ hasText: 'Walden' }).getByRole('button', { name: '找书' }).click()
  await page.waitForURL(/#\/catalogs/)
  assert.equal(await page.getByRole('searchbox', { name: '统一搜书' }).inputValue(), 'Walden Henry David Thoreau')
  await page.waitForFunction(() => document.querySelector('.uni-results'))

  // ---- 远程更新书单: 「更新书单」拉到更新的清单 ----
  remoteIndex = { version: 1, updated: '2099-01-01', lists: ['e2e-remote-list', LIST_ID] }
  await page.getByRole('button', { name: '更新书单' }).click()
  await page.getByText('推荐书单已更新：2 个（2099-01-01）').waitFor()
  await page.locator('.curated-card').filter({ hasText: '远程新书单' }).waitFor()
  assert.equal(await page.locator('.curated-card').count(), 2)
  // 远程不可用且缓存清掉后回到自带书单
  remoteIndex = null
  await page.evaluate(() => localStorage.removeItem('lightread-curated-booklists'))

  // ---- 另一台设备: 导入分享的书单, 然后导入其中一本, 待找条目自动关联 ----
  remoteIndex = null
  const other = await newPage()
  await other.page.goto(base + '/#/library')
  await other.page.locator('.booklist-more').click()
  await other.page.locator('.booklist-heading').getByRole('menuitem', { name: '导入书单' }).click()
  const importDialog = other.page.getByRole('dialog', { name: '导入书单' })
  await importDialog.locator('textarea').fill(json)
  await importDialog.getByText(`共 ${list.books.length + 1} 本，其中 0 本已在藏书`).waitFor()
  assert.equal(await importDialog.getByRole('textbox', { name: '书单名' }).inputValue(), listTitle)
  await importDialog.getByRole('button', { name: '导入书单' }).click()
  await other.page.getByText(`已导入书单「${listTitle}」：0 本已在藏书，${list.books.length + 1} 本待找`).waitFor()
  const otherPanel = other.page.locator('.wanted-panel')
  assert.equal(await otherPanel.locator('.wanted-card').count(), list.books.length + 1)
  await other.page.setInputFiles('input[type=file][multiple]', {
    name: 'walden.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(epubBytes('Walden; or, Life in the Woods', 'Thoreau, Henry David')),
  })
  await other.page.getByText(/成功导入 1 本|已添加 1 本/).first().waitFor({ timeout: 15000 })
  await other.page.locator('.book-card').filter({ hasText: 'Walden' }).waitFor()
  await other.page.waitForFunction(n => document.querySelectorAll('.wanted-card').length === n, list.books.length)
  assert.equal(await otherPanel.locator('.wanted-card').filter({ hasText: 'Walden' }).count(), 0, 'imported book auto-linked')
  // 纯文本清单也能导入
  await other.page.locator('.booklist-more').click()
  await other.page.locator('.booklist-heading').getByRole('menuitem', { name: '导入书单' }).click()
  await importDialog.locator('textarea').fill('# 聊天里的书单\n1. 《活着》— 余华\n2. 《围城》— 钱锺书（1947）')
  await importDialog.getByText('共 2 本，其中 0 本已在藏书').waitFor()
  await importDialog.getByRole('button', { name: '导入书单' }).click()
  await other.page.locator('.booklist-chip.active').filter({ hasText: '聊天里的书单' }).waitFor()
  assert.equal(await otherPanel.locator('.wanted-card').count(), 2)
  // 只有待找条目的书单不显示「空书单」
  assert.equal(await other.page.getByText('这个书单还是空的').count(), 0)
  await other.context.close()

  // ---- 截图: 深色 / 手机 ----
  if (shots) {
    await page.goto(base + '/#/catalogs')
    await setTheme(page, 'dark')
    await page.locator('.curated-card').first().waitFor()
    await page.locator('.curated-section').scrollIntoViewIfNeeded()
    await shot(page, 'catalog-desktop-dark')
    await page.locator('.curated-card').filter({ hasText: listTitle }).click()
    await page.getByRole('heading', { name: listTitle, level: 1 }).waitFor()
    await shot(page, 'curated-detail-desktop-dark')
    await page.goto(base + '/#/library')
    await page.locator('.booklist-chip').filter({ hasText: listTitle }).click()
    await page.locator('.wanted-panel').scrollIntoViewIfNeeded()
    await shot(page, 'library-wanted-desktop-dark')
    await setTheme(page, 'light')
  }
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(base + '/#/catalogs')
    await setTheme(page, theme)
    await page.locator('.curated-card').first().waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile catalog has no horizontal overflow')
    await page.locator('.curated-section').scrollIntoViewIfNeeded()
    await shot(page, `catalog-phone-${theme}`)
    await page.locator('.curated-card').filter({ hasText: listTitle }).click()
    await page.getByRole('heading', { name: listTitle, level: 1 }).waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile detail has no horizontal overflow')
    await shot(page, `curated-detail-phone-${theme}`)
    await page.goto(base + '/#/library')
    await page.locator('.booklist-chip').filter({ hasText: listTitle }).click()
    await page.locator('.wanted-panel').scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile library has no horizontal overflow')
    await shot(page, `library-wanted-phone-${theme}`)
  }
  await context.close()
  assert.deepEqual(errors, [], 'no page errors')
  console.log('PASS e2e-booklists: curated browse → find + download → add all → wanted panel → share → import + auto-link')
} finally {
  await browser.close()
}
