// PDF 绘图批注 e2e: 画笔 / 荧光笔 / 矩形 / 椭圆 / 直线 / 箭头 / 文字框, 以及批注的选中、拖动与删除,
// 最后刷新页面确认落库后能重新画出来 (AnnotationRec.cfi 的 `a:1:` 记录)。
// 运行: npm run dev (或预览服务) 后 npm run e2e:pdf-anno; E2E_BASE 覆盖地址, E2E_MOBILE=1 走 App 视口。
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import * as mupdf from 'mupdf'

const base = process.env.E2E_BASE ?? 'http://localhost:5173'
const mobile = process.env.E2E_MOBILE === '1'

function samplePdf() {
  const buffer = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '')
  const font = new mupdf.Font('Helvetica')
  for (let page = 0; page < 2; page++) {
    const dev = writer.beginPage([0, 0, 595, 842])
    const text = new mupdf.Text()
    text.showString(font, [22, 0, 0, -22, 60, 90], `Annotation sample ${page + 1}`)
    for (let row = 0; row < 20; row++) {
      text.showString(font, [11, 0, 0, -11, 60, 140 + row * 20],
        'Draw on this page: pen, marker, rectangle, ellipse, line, arrow and a text box.')
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
    viewport: mobile ? { width: 392, height: 850 } : { width: 1280, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: 'block',
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  page.on('pageerror', error => errors.push(error.message))

  await page.goto(`${base}/#/library`)
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'anno-sample.pdf', mimeType: 'application/pdf', buffer: samplePdf() },
  ])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 1)
  await page.locator('.book-card').first().click()
  await page.waitForURL(/#\/read-paper\//)
  await page.locator('.p-holder canvas').first().waitFor()
  await page.waitForTimeout(600)

  const holder = page.locator('.p-holder').first()
  const box = await holder.boundingBox()
  assert.ok(box && box.width > 200, '页面没有渲染出来')

  /** 页内相对坐标 (0-1) → 视口坐标 */
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y })

  const stroke = async (points) => {
    await page.mouse.move(points[0].x, points[0].y)
    await page.mouse.down()
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(120)
  }

  const pickTool = async (label) => {
    await page.locator(`.anno-tray .anno-tool[title="${label}"]`).click()
    await page.waitForTimeout(80)
  }

  // 顶栏「批注」→ 工具盘出现, 默认画笔
  await page.locator('button[title="批注"]').click()
  await page.locator('.anno-tray').waitFor()
  await assert.doesNotReject(async () => {
    await page.locator('.anno-tray .anno-tool.active[title="画笔"]').waitFor({ timeout: 2000 })
  })

  // 1. 画笔: 手绘一条曲线
  await stroke([at(0.2, 0.16), at(0.3, 0.2), at(0.42, 0.17), at(0.52, 0.22)])

  // 2. 荧光笔: 横着刷一道 (半透明, 走 multiply 混合)
  await pickTool('荧光笔')
  await stroke([at(0.2, 0.28), at(0.5, 0.28), at(0.7, 0.29)])

  // 3. 矩形
  await pickTool('矩形')
  await stroke([at(0.2, 0.36), at(0.4, 0.42)])

  // 4. 椭圆
  await pickTool('椭圆')
  await stroke([at(0.5, 0.36), at(0.72, 0.43)])

  // 5. 直线
  await pickTool('直线')
  await stroke([at(0.2, 0.5), at(0.45, 0.56)])

  // 6. 箭头
  await pickTool('箭头')
  await stroke([at(0.55, 0.5), at(0.8, 0.58)])

  const vectorCount = () => page.locator('.anno-layer svg > g:not(.anno-draft)').count()
  assert.equal(await vectorCount(), 6, '六种绘图批注应该都落在页面上')

  // 7. 文字框: 点一下落框, 直接输入, 点别处保存
  await pickTool('文字')
  await page.mouse.click(at(0.22, 0.66).x, at(0.22, 0.66).y)
  const noteInput = page.locator('.anno-text-box-input')
  await noteInput.waitFor()
  await noteInput.fill('这一段的论证要再读一遍')
  await page.mouse.click(at(0.7, 0.8).x, at(0.7, 0.8).y)
  await page.waitForTimeout(300)
  assert.equal(await page.locator('.anno-text-box').count(), 1, '文字框应该画在页面上')
  assert.match(await page.locator('.anno-text-box').first().innerText(), /论证/)

  // 8. 选择态: 点中矩形 → 出现选择框; 拖一下 → 位置变化; Delete 删除
  await pickTool('选择')
  await page.mouse.click(at(0.3, 0.39).x, at(0.3, 0.39).y)
  await page.locator('.anno-sel').waitFor({ timeout: 4000 })
  const selectionFrame = () => page.evaluate(() => {
    const el = document.querySelector('.anno-sel')
    return el ? `${el.style.left}/${el.style.top}` : ''
  })
  const beforeCfi = await selectionFrame()
  await stroke([at(0.3, 0.39), at(0.36, 0.43)])
  await page.waitForTimeout(300)
  const afterCfi = await selectionFrame()
  assert.notEqual(afterCfi, beforeCfi, '拖动应该移动批注')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(300)
  assert.equal(await vectorCount(), 5, '删除后应该只剩五条绘图批注')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.anno-tray').count(), 0, 'Esc 应退出批注工具')

  // 8.5 文字类批注: 拖选文字 → 选区工具条里的下划线 / 删除线
  const selectText = async (yRatio, fromX, toX) => {
    await page.mouse.move(at(fromX, yRatio).x, at(fromX, yRatio).y)
    await page.mouse.down()
    await page.mouse.move(at(toX, yRatio).x, at(toX, yRatio).y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(320)
  }
  const lineMarks = () => page.locator('.p-hl-rect.p-hl-line').count()

  await selectText(0.2, 0.15, 0.6)
  await page.locator('.sel-act', { hasText: '下划线' }).first().click()
  await page.waitForTimeout(260)
  await selectText(0.245, 0.15, 0.6)
  await page.locator('.sel-act', { hasText: '删除线' }).first().click()
  await page.waitForTimeout(260)
  assert.equal(await lineMarks(), 2, '下划线与删除线应该落在页面上')

  const shot = join(tmpdir(), 'lightread-pdf-anno.png')
  await page.screenshot({ path: shot })

  // 9. 刷新后重新读库: 批注要能重新画出来
  await page.reload()
  await page.locator('.p-holder canvas').first().waitFor()
  await page.waitForTimeout(800)
  assert.equal(await vectorCount(), 5, '刷新后绘图批注应该从存储里恢复')
  assert.equal(await page.locator('.anno-text-box').count(), 1, '刷新后文字批注也应该还在')
  assert.match(await page.locator('.anno-text-box').first().innerText(), /论证/)
  assert.equal(await page.locator('.p-hl-rect.p-hl-line').count(), 2, '刷新后下划线与删除线也应该还在')

  // 10. 笔记抽屉列出绘图批注
  await page.locator('button[title="目录"]').click()
  await page.locator('.drawer-tabs button', { hasText: '划线想法' }).click()
  await page.waitForTimeout(200)
  const items = await page.locator('.drawer-body .anno-item').count()
  assert.equal(items, 8, '抽屉里应有 5 条绘图批注 + 1 条文字批注 + 2 条文字标记')

  // 11. 换成滚动模式: 同一套页内坐标, 批注要跟着页面走
  await page.locator('.drawer-head button[title="关闭"]').click()
  await page.locator('.view-trigger').click()
  await page.locator('.view-choice', { hasText: '滚动' }).first().click()
  await page.waitForTimeout(1200)
  assert.ok(await page.locator('.pane-left .p-holder').count() >= 1, '滚动模式没有渲染页面')
  assert.equal(await vectorCount(), 5, '滚动模式下绘图批注也应该画出来')
  assert.equal(await page.locator('.anno-text-box').count(), 1, '滚动模式下文字批注也应该画出来')

  assert.deepEqual(errors, [], `页面报错: ${errors.join(' / ')}`)
  console.log(`✓ PDF 绘图批注 e2e 通过 (截图: ${shot})`)
} finally {
  await browser.close()
}
