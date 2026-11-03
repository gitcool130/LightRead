// 「查」字 e2e: PDF 顶栏开启查字 → 选中汉字 → 浮卡显示拼音与释义。
// 运行: npm run dev 后 npm run e2e:pdf-lookup; E2E_BASE 覆盖地址。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE ?? 'http://localhost:5173'
const fixture = readFileSync(new URL('./fixtures/hanzi-sample.pdf', import.meta.url))

const browser = await chromium.launch()
const errors = []
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  page.on('pageerror', error => errors.push(error.message))

  await page.goto(`${base}/#/library`)
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'hanzi-sample.pdf', mimeType: 'application/pdf', buffer: fixture },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1)
  await page.locator('.book-card').first().click()
  await page.waitForURL(/#\/read-paper\//)
  await page.locator('.p-holder canvas').first().waitFor()
  await page.waitForTimeout(700)

  const holder = page.locator('.p-holder').first()
  const box = await holder.boundingBox()
  assert.ok(box && box.width > 200, '页面没有渲染出来')
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y })

  /** 在页面上拖选一行文字 */
  const selectLine = async (yRatio, fromX, toX) => {
    await page.mouse.move(at(fromX, yRatio).x, at(fromX, yRatio).y)
    await page.mouse.down()
    await page.mouse.move(at(toX, yRatio).x, at(toX, yRatio).y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(420)
  }

  // 1. 顶栏有「查」按钮, 点开进入查字模式
  const lookupBtn = page.locator('.top-lookup')
  assert.equal(await lookupBtn.count(), 1, '顶栏应有查字按钮')
  assert.equal(await lookupBtn.getAttribute('aria-pressed'), 'false')
  await lookupBtn.click()
  await page.waitForTimeout(120)
  assert.equal(await lookupBtn.getAttribute('aria-pressed'), 'true', '点一下应进入查字模式')

  // 2. 选中「六爻者，易之占也。」→ 直接出查字卡
  await selectLine(0.135, 0.1, 0.46)
  await page.locator('.hanzi-card').waitFor({ timeout: 8000 })
  const cardText = await page.locator('.hanzi-card').innerText()
  assert.ok(cardText.includes('爻'), `卡片应列出爻字: ${cardText.slice(0, 80)}`)
  assert.ok(/y[aáǎà]o/i.test(cardText), `爻应有拼音 yáo: ${cardText.slice(0, 80)}`)
  assert.ok(cardText.includes('六'), '卡片应列出六字')

  // 查字模式下不该再弹划词工具条
  assert.equal(await page.locator('.sel-bar').count(), 0, '查字模式不该同时弹划词工具条')

  // 3. Esc 关闭卡片, 模式仍然开着
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.hanzi-card').count(), 0, 'Esc 应关闭查字卡')
  assert.equal(await lookupBtn.getAttribute('aria-pressed'), 'true', 'Esc 只关卡片, 不退出查字模式')

  // 4. 关掉查字模式后, 划词工具条里的「查」也能查
  await lookupBtn.click()
  await page.waitForTimeout(120)
  assert.equal(await lookupBtn.getAttribute('aria-pressed'), 'false')
  await selectLine(0.176, 0.1, 0.5)
  await page.locator('.sel-bar').waitFor({ timeout: 6000 })
  await page.locator('.sel-bar .sel-act', { hasText: '查' }).first().click()
  await page.locator('.hanzi-card').waitFor({ timeout: 8000 })
  const cardText2 = await page.locator('.hanzi-card').innerText()
  assert.ok(cardText2.includes('乾') || cardText2.includes('彖'), `第二个卡片应列出选区汉字: ${cardText2.slice(0, 80)}`)

  const shot = join(tmpdir(), 'lightread-pdf-lookup.png')
  await page.screenshot({ path: shot })
  assert.deepEqual(errors, [], `页面报错: ${errors.join(' / ')}`)
  console.log(`✓ 查字 e2e 通过 (截图: ${shot})`)
} finally {
  await browser.close()
}
