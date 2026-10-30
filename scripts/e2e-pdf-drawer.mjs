// 临时验证: PDF 阅读器目录栏宽度可自由拖动
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import * as mupdf from 'mupdf'

const base = process.env.E2E_BASE ?? 'http://localhost:5173'

function samplePdf() {
  const buffer = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '')
  const font = new mupdf.Font('Helvetica')
  for (let page = 0; page < 2; page++) {
    const dev = writer.beginPage([0, 0, 595, 842])
    const text = new mupdf.Text()
    text.showString(font, [22, 0, 0, -22, 60, 90], `Drawer sample ${page + 1}`)
    for (let row = 0; row < 20; row++) {
      text.showString(font, [11, 0, 0, -11, 60, 140 + row * 20],
        'A line of body text to check that the reading area reflows when the outline gets wider.')
    }
    dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
    writer.endPage()
  }
  writer.close()
  return Buffer.from(buffer.asUint8Array())
}

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
  page.on('pageerror', e => errors.push(e.message))

  await page.goto(`${base}/#/library`)
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'drawer-sample.pdf', mimeType: 'application/pdf', buffer: samplePdf() },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1)
  await page.locator('.book-card').first().click()
  await page.waitForURL(/#\/read-paper\//)
  await page.locator('.p-holder canvas').first().waitFor()
  await page.waitForTimeout(800)

  // 打开侧栏 (顶栏左侧带 aria-pressed 的目录按钮)
  await page.locator('.topbar-start button[aria-pressed]').click()
  const drawer = page.locator('.side-drawer')
  await drawer.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)

  const before = (await drawer.boundingBox())?.width ?? 0
  console.log('初始目录栏宽度 =', Math.round(before))
  assert.ok(before > 200, `默认宽度异常: ${before}`)

  const splitter = page.locator('.drawer-splitter')
  const sbox = await splitter.boundingBox()
  assert.ok(sbox && sbox.width > 0, '拖拽把手没有渲染')

  const paneBefore = (await page.locator('.pane-left-wrap').boundingBox())?.width ?? 0

  // 向右拖 150px → 目录栏变宽, 正文变窄
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sbox.x + sbox.width / 2 + 150, sbox.y + sbox.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const wider = (await drawer.boundingBox())?.width ?? 0
  const paneAfter = (await page.locator('.pane-left-wrap').boundingBox())?.width ?? 0
  console.log('拖宽后 =', Math.round(wider), '| 正文', Math.round(paneBefore), '->', Math.round(paneAfter))
  assert.ok(wider > before + 100, `拖动没生效: ${before} -> ${wider}`)
  assert.ok(paneAfter < paneBefore, '正文没有让位')

  // 向左拖过头 → 卡在下限, 不塌陷
  await page.mouse.move(sbox.x + sbox.width / 2 + 150, sbox.y + sbox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sbox.x - 600, sbox.y + sbox.height / 2, { steps: 14 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const narrow = (await drawer.boundingBox())?.width ?? 0
  console.log('拖到极限 =', Math.round(narrow))
  assert.ok(narrow >= 179 && narrow <= 181, `下限没卡住: ${narrow}`)

  // 双击复位
  const sbox2 = await splitter.boundingBox()
  await page.mouse.dblclick(sbox2.x + sbox2.width / 2, sbox2.y + sbox2.height / 2)
  await page.waitForTimeout(300)
  const reset = (await drawer.boundingBox())?.width ?? 0
  console.log('双击复位 =', Math.round(reset))
  assert.ok(Math.abs(reset - 292) <= 1, `复位失败: ${reset}`)

  // 刷新后记住宽度: 先拖到 ~420, 再 reload
  const sbox3 = await splitter.boundingBox()
  await page.mouse.move(sbox3.x + sbox3.width / 2, sbox3.y + sbox3.height / 2)
  await page.mouse.down()
  await page.mouse.move(sbox3.x + sbox3.width / 2 + 128, sbox3.y + sbox3.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const saved = (await drawer.boundingBox())?.width ?? 0
  await page.reload()
  await page.locator('.p-holder canvas').first().waitFor()
  await page.waitForTimeout(500)
  await page.locator('.topbar-start button[aria-pressed]').click()
  await drawer.waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  const restored = (await drawer.boundingBox())?.width ?? 0
  console.log('记住宽度 =', Math.round(saved), '-> 重开后', Math.round(restored))
  assert.ok(Math.abs(restored - saved) <= 1, `宽度没记住: ${saved} -> ${restored}`)

  await page.screenshot({ path: '/d/AI/lr/shot-drawer-width.png' })
  assert.equal(errors.length, 0, `页面报错: ${errors.join(' | ')}`)
  console.log('全部通过')
} finally {
  await browser.close()
}
