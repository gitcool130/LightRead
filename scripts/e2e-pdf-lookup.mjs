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

  // 语音合成打桩: 记录被朗读的文本, 不真的出声
  await page.addInitScript(() => {
    const spoken = []
    window.__spoken = spoken
    class FakeUtterance {
      constructor(text) { this.text = text }
    }
    window.SpeechSynthesisUtterance = FakeUtterance
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [{ name: 'Stub Mandarin', lang: 'zh-CN', voiceURI: 'stub', default: true }],
        speak: u => { spoken.push(u.text); setTimeout(() => u.onend?.(), 10) },
        cancel: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })
  })

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

  // 3. 卡片里每个字都能朗读: 点喇叭 → 交给语音合成的应该是那个汉字
  await page.locator('.hanzi-card .hanzi-speak').first().click()
  await page.waitForTimeout(400)
  const spoken = await page.evaluate(() => window.__spoken ?? [])
  assert.ok(spoken.length >= 1, `点喇叭应触发朗读, 实际: ${JSON.stringify(spoken)}`)
  assert.match(spoken[0], /^[\u4e00-\u9fff]$/, `朗读内容应是单个汉字: ${spoken[0]}`)
  const firstChar = await page.locator('.hanzi-card .hanzi-char').first().innerText()
  assert.equal(spoken[0], firstChar.trim(), '朗读的字应与卡片上第一个字一致')

  // 4. Esc 关闭卡片, 模式仍然开着
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.hanzi-card').count(), 0, 'Esc 应关闭查字卡')
  assert.equal(await lookupBtn.getAttribute('aria-pressed'), 'true', 'Esc 只关卡片, 不退出查字模式')

  // 5. 关掉查字模式后, 划词工具条里的「查」也能查
  await lookupBtn.click()
  await page.waitForTimeout(120)
  assert.equal(await lookupBtn.getAttribute('aria-pressed'), 'false')
  await selectLine(0.176, 0.1, 0.5)
  await page.locator('.sel-bar').waitFor({ timeout: 6000 })
  await page.locator('.sel-bar .sel-act', { hasText: '查' }).first().click()
  await page.locator('.hanzi-card').waitFor({ timeout: 8000 })
  const cardText2 = await page.locator('.hanzi-card').innerText()
  assert.ok(cardText2.includes('乾') || cardText2.includes('彖'), `第二个卡片应列出选区汉字: ${cardText2.slice(0, 80)}`)

  // 6. 回归: 缩放比例菜单开着时, 顶栏 + 必须一次点中 (曾被弹层遮罩吃掉第一次点击)
  const zoomLabel = () => page.locator('.dock-zoom span').first().innerText()
  await page.locator('.dock-zoom').first().click()
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.zoom-menu').count(), 1, '缩放比例菜单应打开')
  const before = await zoomLabel()
  await page.locator('.top-cluster .top-icon').last().click()
  await page.waitForTimeout(500)
  assert.equal(await page.locator('.zoom-menu').count(), 0, '点 + 后缩放菜单应收起')
  assert.notEqual(await zoomLabel(), before, '菜单开着时点 + 也要真的放大')

  const shot = join(tmpdir(), 'lightread-pdf-lookup.png')
  await page.screenshot({ path: shot })
  assert.deepEqual(errors, [], `页面报错: ${errors.join(' / ')}`)
  console.log(`✓ 查字 e2e 通过 (截图: ${shot})`)
} finally {
  await browser.close()
}
