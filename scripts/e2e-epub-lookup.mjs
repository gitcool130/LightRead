// EPUB 「查」e2e: 顶栏查字按钮 → 选中正文 → 浮卡出拼音与释义; 划词工具条里的「查」也能用。
// 运行: npm run dev 后 npm run e2e:epub-lookup; E2E_BASE 覆盖地址。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE ?? 'http://localhost:5173'
const fixture = readFileSync(new URL('./fixtures/hanzi-epub.epub', import.meta.url))

const browser = await chromium.launch()
const errors = []
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 860 },
    serviceWorkers: 'block',
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  page.on('pageerror', error => errors.push(error.message))

  await page.goto(`${base}/#/library`)
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'hanzi.epub', mimeType: 'application/epub+zip', buffer: fixture },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1)
  await page.locator('.book-card').first().click()
  await page.waitForURL(/#\/read\//)
  await page.waitForTimeout(2500)

  // 1. 顶栏有查字按钮
  const lookupBtn = page.locator('.lookup-btn')
  assert.equal(await lookupBtn.count(), 1, 'EPUB 顶栏应有查字按钮')
  await lookupBtn.click()
  await page.waitForTimeout(250)

  // 2. 在正文 iframe 里选中一段 → 直接出查字卡
  const frame = page.frames().find(f => f !== page.mainFrame())
  assert.ok(frame, '没找到正文 iframe')
  const selected = await frame.evaluate(() => {
    const p = document.querySelector('p')
    if (!p) return ''
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return sel.toString().trim()
  })
  assert.ok(selected.includes('六爻'), `正文应能选中汉字: ${selected.slice(0, 20)}`)

  await page.locator('.hanzi-card').waitFor({ timeout: 8000 })
  const cardText = await page.locator('.hanzi-card').innerText()
  assert.ok(cardText.includes('爻'), `卡片应列出爻字: ${cardText.slice(0, 60)}`)
  assert.ok(/y[aáǎà]o/i.test(cardText), `爻应有拼音 yáo: ${cardText.slice(0, 60)}`)
  assert.equal(await page.locator('.highlight-bar').count(), 0, '查字模式不该同时弹划词工具条')

  // 3. 关闭卡片
  await page.locator('.hanzi-card .icon-btn').click()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.hanzi-card').count(), 0, '关掉后卡片应消失')

  // 4. 退出查字模式 → 划词工具条恢复, 直接用里面的「查」
  await lookupBtn.click()
  await page.waitForTimeout(200)
  await frame.evaluate(() => {
    const p = document.querySelectorAll('p')[1] ?? document.querySelector('p')
    const range = document.createRange()
    range.selectNodeContents(p)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await page.locator('.highlight-bar').waitFor({ timeout: 8000 })
  await page.locator('.highlight-bar button', { hasText: '查字' }).first().click()
  await page.locator('.hanzi-card').waitFor({ timeout: 8000 })
  const cardText2 = await page.locator('.hanzi-card').innerText()
  assert.ok(cardText2.includes('筮') || cardText2.includes('卦'), `第二个卡片应列出选中汉字: ${cardText2.slice(0, 60)}`)

  const shot = join(tmpdir(), 'lightread-epub-lookup.png')
  await page.screenshot({ path: shot })
  assert.deepEqual(errors, [], `页面报错: ${errors.join(' / ')}`)
  console.log(`✓ EPUB 查字 e2e 通过 (截图: ${shot})`)
} finally {
  await browser.close()
}
