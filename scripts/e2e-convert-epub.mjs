/**
 * 格式转换端到端: 导入 AZW3 / MOBI / FB2 / TXT → 「转换为 EPUB」(单本 + 批量) → 新 EPUB 在阅读器里
 * 有正文、目录与图片; 书单归属与阅读进度带过去; DRM 文件给出明确提示且原书不变; 打包结构合规.
 *
 * 先构建并起预览: npm run build && npx vite preview --port 4173 --strictPort &
 * 运行: flock /tmp/heavy.lock nice -n 10 node scripts/e2e-convert-epub.mjs
 * 真实 Kindle 样本 (古登堡《爱丽丝》, 不在测试里下载):
 *   E2E_AZW3=/tmp/lightread-real.azw3  (https://www.gutenberg.org/ebooks/11.kf8.images)
 *   E2E_MOBI=/tmp/lightread-real.azw   (https://www.gutenberg.org/ebooks/11.kindle.images)
 * 可选: EPUBCHECK_JAR=/path/epubcheck.jar 时对转换结果跑 epubcheck (只允许 0 个 ERROR/FATAL).
 * FB2 / TXT 样本由本脚本生成 (含封面、插图、脚注、嵌套章节).
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

/** 纯色 + 对角条纹的 RGB PNG (无外部依赖) */
export function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const stripe = ((x + y) >> 3) % 2 === 0
      raw[row + 1 + x * 3] = stripe ? r : 255 - r
      raw[row + 2 + x * 3] = stripe ? g : 255 - g
      raw[row + 3 + x * 3] = stripe ? b : 255 - b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** FictionBook 2 样本: 封面、插图、脚注 (第二个 body)、嵌套章节、需要转义的字符 */
export function makeFb2() {
  const cover = makePng(120, 160, [40, 90, 200]).toString('base64')
  const pic = makePng(64, 48, [220, 120, 30]).toString('base64')
  const para = (n) => Array.from({ length: n }, (_, i) =>
    `<p>第 ${i + 1} 段：兔子洞很深，爱丽丝一直往下掉 &amp; 想着 &lt;猫&gt; 会不会想她。</p>`).join('\n')
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
  <title-info>
    <genre>prose_classic</genre>
    <author><first-name>刘易斯</first-name><last-name>卡罗尔</last-name></author>
    <book-title>FB2 转换样本</book-title>
    <annotation><p>一本用来测试 <emphasis>格式转换</emphasis> 的书。</p></annotation>
    <date value="1865-11-26">1865</date>
    <coverpage><image l:href="#cover.png"/></coverpage>
    <lang>zh</lang>
  </title-info>
  <document-info><author><nickname>LightRead</nickname></author><id>fb2-convert-e2e</id><version>1.0</version></document-info>
  <publish-info><publisher>轻阅测试社</publisher></publish-info>
</description>
<body>
  <title><p>FB2 转换样本</p></title>
  <section id="ch1">
    <title><p>第一章 掉进兔子洞</p></title>
    <epigraph><p>“我的耳朵和胡子呀！”</p><text-author>白兔</text-author></epigraph>
    <p>FB2-BODY-MARKER 开头的一段，带脚注<a l:href="#n1" type="note">[1]</a>，还有<strong>粗体</strong>与<emphasis>斜体</emphasis>。</p>
    <image l:href="#pic.png"/>
    ${para(30)}
    <p>跳到 <a l:href="#ch2">第二章</a>。</p>
  </section>
  <section id="ch2">
    <title><p>第二章 眼泪池</p></title>
    <section id="ch2-1"><title><p>2.1 越来越奇怪</p></title>${para(20)}</section>
    <section id="ch2-2"><title><p>2.2 老鼠的故事</p></title>
      <poem><stanza><v>一行诗</v><v>又一行诗</v></stanza></poem>
      ${para(20)}
    </section>
  </section>
</body>
<body name="notes">
  <title><p>注释</p></title>
  <section id="n1"><title><p>1</p></title><p>FB2-NOTE-MARKER 这是脚注内容。</p></section>
</body>
<binary id="cover.png" content-type="image/png">${cover}</binary>
<binary id="pic.png" content-type="image/png">${pic}</binary>
</FictionBook>
`, 'utf-8')
}

/** 把 MOBI 头 (含 KF8 部分) 的加密标记置为 Mobipocket DRM, 模拟受保护文件 */
export function markMobiDrm(buf) {
  const out = Buffer.from(buf)
  const n = out.readUInt16BE(76)
  for (let i = 0; i < n; i++) {
    const off = out.readUInt32BE(78 + i * 8)
    if (out.toString('latin1', off + 16, off + 20) === 'MOBI') out.writeUInt16BE(2, off + 12)
  }
  return out
}

async function main() {
  const { chromium } = await import('playwright')
  const { unzipSync, strFromU8 } = await import('fflate')
  const base = process.env.E2E_BASE ?? 'http://localhost:4173'
  const TMP = process.env.E2E_OUT ?? '/tmp/lightread-convert-e2e'
  const SHOTS = process.env.E2E_SHOTS ?? join(TMP, 'shots')
  mkdirSync(TMP, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })

  const azw3 = readFileSync(process.env.E2E_AZW3 ?? '/tmp/lightread-real.azw3')
  const mobi = readFileSync(process.env.E2E_MOBI ?? '/tmp/lightread-real.azw')
  for (const b of [azw3, mobi]) assert.equal(b.subarray(60, 68).toString(), 'BOOKMOBI', 'Kindle fixture must be a genuine MOBI file')
  const files = {
    azw3: join(TMP, 'alice-kf8.azw3'),
    mobi: join(TMP, 'alice-legacy.mobi'),
    fb2: join(TMP, 'FB2 转换样本.fb2'),
    txt: join(TMP, '转换文本.txt'),
    drm: join(TMP, 'drm-protected.mobi'),
  }
  writeFileSync(files.azw3, azw3)
  writeFileSync(files.mobi, mobi)
  writeFileSync(files.fb2, makeFb2())
  writeFileSync(files.txt, '第一章 起点\nTXT-BODY-MARKER 正文 & <符号> 都要保留。\n'.repeat(3) + '\n第二章 终点\n结束。\n', 'utf-8')
  writeFileSync(files.drm, markMobiDrm(mobi))

  const browser = await chromium.launch()
  const errors = []
  let failed = false
  const step = async (name, fn) => {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (e) {
      failed = true
      console.log(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 6).join('\n    ')}`)
      throw e
    }
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' })
  await context.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.0.0', assets: [] }) }))
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', e => errors.push(`${e.message}\n${e.stack ?? ''}`.slice(0, 600)))

  /** IndexedDB 原始读写 (lightread 库) */
  const idb = (fn, arg) => page.evaluate(async ({ src, arg }) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('lightread')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const run = (store, mode, f) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode)
      const result = f(tx.objectStore(store))
      tx.oncomplete = () => resolve(result?.result ?? result)
      tx.onerror = () => reject(tx.error)
    })
    try {
      // eslint-disable-next-line no-new-func
      return await new Function('run', 'arg', `return (${src})(run, arg)`)(run, arg)
    } finally { db.close() }
  }, { src: fn.toString(), arg })
  const listBooks = () => idb(async (run) => {
    const rows = await run('books', 'readonly', s => s.getAll())
    return rows.map(({ file, cover, ...m }) => ({ ...m, size: file?.byteLength ?? 0, coverSize: cover?.byteLength ?? 0 }))
  })
  const card = (title, format) => page.locator('.book-card', { has: page.locator('.format', { hasText: new RegExp(`^${format}$`) }) })
    .filter({ has: page.locator('.title', { hasText: title }) })

  try {
    await step('import AZW3 / MOBI / FB2 / TXT / DRM-flagged MOBI', async () => {
      await page.goto(base + '/')
      await page.waitForSelector('text=书架还是空的')
      await page.setInputFiles('input[type=file][multiple]', Object.values(files))
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 5, null, { timeout: 30_000 })
      const books = await listBooks()
      assert.deepEqual(books.map(b => b.format).sort(), ['azw3', 'fb2', 'mobi', 'mobi', 'txt'])
    })

    let books = await listBooks()
    const kf8 = books.find(b => b.format === 'azw3')
    const fb2 = books.find(b => b.format === 'fb2')
    await step('prepare booklist membership + 50% progress on the AZW3', async () => {
      await idb(async (run, { id, drmId }) => {
        await run('books', 'readwrite', s => {
          const req = s.get(drmId)
          req.onsuccess = () => s.put({ ...req.result, title: 'DRM 测试书' })
        })
        await run('booklists', 'readwrite', s => s.put({ id: 'bl-convert', name: '转换测试书单', createdAt: 1, updatedAt: 1 }))
        await run('booklistItems', 'readwrite', s => s.put({ booklistId: 'bl-convert', bookId: id, addedAt: 1 }))
        await run('books', 'readwrite', s => {
          const req = s.get(id)
          req.onsuccess = () => s.put({ ...req.result, progress: 0.5, lastReadAt: Date.now() })
        })
      }, { id: kf8.id, drmId: books.find(b => b.fileName === 'drm-protected.mobi').id })
      await page.reload()
      await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 5)
    })

    await step('convert action shown only for convertible formats', async () => {
      const cards = page.locator('.book-card')
      assert.equal(await cards.locator('.action.convert').count(), 5)
      const btn = card(kf8.title, 'AZW3').locator('.action.convert')
      assert.equal(await btn.getAttribute('aria-label'), '转换为 EPUB')
      assert.equal(await btn.getAttribute('title'), '转换为 EPUB')
    })

    await step('convert AZW3 from the card menu → toast with 打开', async () => {
      const c = card(kf8.title, 'AZW3')
      await c.hover()
      await c.locator('.meta-more').click()
      await c.locator('.action.convert').click()
      const toast = page.locator('.toast', { hasText: '已转换为 EPUB' })
      await toast.waitFor({ timeout: 60_000 })
      await page.screenshot({ path: join(SHOTS, 'convert-toast.png') })
      books = await listBooks()
      const epubs = books.filter(b => b.format === 'epub')
      assert.equal(epubs.length, 1)
      const out = epubs[0]
      assert.equal(out.title, kf8.title)
      assert.equal(out.author, kf8.author)
      assert.equal(out.progress, 0.5)
      assert.ok(!out.location)
      assert.ok(out.hasCover && out.coverSize > 0, 'cover carried over')
      assert.match(out.fileName, /\.epub$/)
      assert.ok(books.some(b => b.id === kf8.id && b.format === 'azw3' && b.size === azw3.length), 'original kept unchanged')
      const members = await idb(async (run) => run('booklistItems', 'readonly', s => s.getAll()))
      assert.ok(members.some(m => m.booklistId === 'bl-convert' && m.bookId === out.id), 'booklist membership copied')
      assert.equal(await card(kf8.title, 'EPUB').locator('.action.convert').count(), 0, 'EPUB is not offered for conversion')
    })

    await step('open the converted AZW3 from the toast: text, TOC, images, progress ~50%', async () => {
      await page.locator('.toast .toast-action', { hasText: '打开' }).click()
      await page.waitForURL(/#\/read\//)
      await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body?.textContent?.trim().length > 50, null, { timeout: 30_000 })
      const pct = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.fraction ?? -1)
      assert.ok(pct > 0.35 && pct < 0.65, `progress restored by percentage, got ${pct}`)
      await page.screenshot({ path: join(SHOTS, 'convert-reader-azw3.png') })
      const toc = await page.evaluate(() => {
        const flat = items => items.flatMap(i => [i, ...flat(i.subitems ?? [])])
        return flat(document.querySelector('foliate-view').book.toc ?? []).map(i => i.label)
      })
      assert.ok(toc.length >= 12, `toc entries: ${toc.length}`)
      assert.ok(toc.some(l => /Rabbit-Hole/i.test(l)), 'chapter titles kept')
      // 有插图的章节: 找到第一张图并确认解码成功
      const img = await page.evaluate(async () => {
        const view = document.querySelector('foliate-view')
        for (let i = 0; i < view.book.sections.length; i++) {
          const doc = await view.book.sections[i].createDocument()
          if (doc.querySelector('img, image')) { await view.goTo(i); return i }
        }
        return -1
      })
      assert.ok(img >= 0, 'converted book has images')
      // KF8 的封面页是 SVG <image>: 资源在包内时 foliate 会换成 blob: URL, 取回来是真图片
      await page.waitForFunction(async () => {
        const doc = document.querySelector('foliate-view').renderer.getContents()[0]?.doc
        const im = doc?.querySelector('img, image')
        if (!im) return false
        if (im.localName === 'img') {
          try { await im.decode() } catch { return false }
          return im.naturalWidth > 0
        }
        const href = im.getAttribute('href') ?? im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? ''
        if (!href.startsWith('blob:')) return false
        const blob = await (await fetch(href)).blob()
        const bmp = await createImageBitmap(blob).catch(() => null)
        return !!bmp && bmp.width > 100
      }, null, { timeout: 20_000 })
      await page.screenshot({ path: join(SHOTS, 'convert-reader-azw3-cover.png') })
      await page.locator('button[title="目录"]').first().click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, 'convert-reader-azw3-toc.png') })
      await page.goBack()
      await page.waitForSelector('.book-card')
    })

    await step('batch convert MOBI + FB2 + TXT in manage mode', async () => {
      await page.getByRole('button', { name: '管理', exact: true }).click()
      for (const [title, fmt] of [[fb2.title, 'FB2'], ['转换文本', 'TXT']]) await card(title, fmt).click()
      await card(kf8.title, 'MOBI').click()
      await page.screenshot({ path: join(SHOTS, 'convert-batch-select.png') })
      await page.locator('.batch-bar').getByRole('button', { name: '转换为 EPUB' }).click()
      await page.locator('.toast', { hasText: '已将 3 本转换为 EPUB' }).waitFor({ timeout: 90_000 })
      await page.getByRole('button', { name: '完成', exact: true }).first().click()
      books = await listBooks()
      assert.equal(books.filter(b => b.format === 'epub').length, 4)
      const fb2Epub = books.find(b => b.format === 'epub' && b.title === fb2.title)
      assert.ok(fb2Epub, 'FB2 converted')
      assert.equal(fb2Epub.author, fb2.author)
      assert.ok(fb2Epub.coverSize > 0)
    })

    await step('open the converted FB2: body text, footnote link, illustration, nested TOC', async () => {
      const id = books.find(b => b.format === 'epub' && b.title === fb2.title).id
      await page.goto(`${base}/#/read/${id}`)
      await page.waitForFunction(() => document.querySelector('foliate-view')?.book?.sections?.length > 0, null, { timeout: 30_000 })
      await page.waitForFunction(() => !document.body.innerText.includes('正在打开'), null, { timeout: 30_000 })
      const info = await page.evaluate(async () => {
        const view = document.querySelector('foliate-view')
        const flat = items => items.flatMap(i => [i, ...flat(i.subitems ?? [])])
        const toc = flat(view.book.toc ?? []).map(i => i.label)
        let marker = -1, noteHref = '', imgSection = -1, note = -1
        for (let i = 0; i < view.book.sections.length; i++) {
          const doc = await view.book.sections[i].createDocument()
          const text = doc.body?.textContent ?? ''
          if (text.includes('FB2-BODY-MARKER')) {
            marker = i
            noteHref = doc.querySelector('a[href*="#"]')?.getAttribute('href') ?? ''
          }
          if (doc.querySelector('img') && marker === i) imgSection = i
          if (text.includes('FB2-NOTE-MARKER')) note = i
        }
        return { toc, marker, noteHref, imgSection, note, sections: view.book.sections.length, title: view.book.metadata?.title, cover: !!(await view.book.getCover()) }
      })
      assert.ok(info.marker >= 0, 'body text present')
      assert.ok(info.imgSection === info.marker, 'illustration kept in chapter')
      assert.ok(info.note > info.marker, 'notes body kept')
      assert.match(info.noteHref, /\.xhtml#n1$/, `footnote link rewritten: ${info.noteHref}`)
      assert.ok(info.toc.includes('第一章 掉进兔子洞') && info.toc.includes('2.2 老鼠的故事'), `toc: ${info.toc.join(' | ')}`)
      assert.ok(info.cover, 'cover image in package')
      await page.evaluate(i => document.querySelector('foliate-view').goTo(i), info.marker)
      await page.waitForFunction(async () => {
        const doc = document.querySelector('foliate-view').renderer.getContents()[0]?.doc
        const im = doc?.querySelector('img')
        if (!im) return false
        try { await im.decode() } catch { return false }
        return im.naturalWidth === 64 && doc.body.textContent.includes('FB2-BODY-MARKER')
      }, null, { timeout: 20_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(SHOTS, 'convert-reader-fb2.png') })
    })

    await step('DRM-protected MOBI: clear error, original untouched', async () => {
      await page.goto(base + '/')
      await page.waitForSelector('.book-card')
      const before = (await listBooks()).length
      const drm = (await listBooks()).find(b => b.fileName === 'drm-protected.mobi')
      const target = card('DRM 测试书', 'MOBI')
      await target.hover()
      await target.locator('.meta-more').click()
      await target.locator('.action.convert').click()
      await page.locator('.toast.error', { hasText: 'DRM' }).waitFor({ timeout: 30_000 })
      await page.screenshot({ path: join(SHOTS, 'convert-drm-error.png') })
      const after = await listBooks()
      assert.equal(after.length, before)
      assert.equal(after.find(b => b.id === drm.id).size, readFileSync(files.drm).length)
    })

    await step('mobile: 更多 menu exposes 转换为 EPUB without clipping', async () => {
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: 'block' })
      await mobile.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"tag_name":"v0.0.0","assets":[]}' }))
      const m = await mobile.newPage()
      await m.goto(base + '/')
      await m.waitForSelector('text=书架还是空的')
      await m.setInputFiles('input[type=file][multiple]', [files.fb2])
      await m.waitForSelector('.book-card')
      const c = m.locator('.book-card').first()
      const sheet = await c.locator('.meta-more').isVisible()
      await c.locator(sheet ? '.meta-more' : '.action.more').tap()
      const btn = sheet ? m.getByRole('dialog').getByRole('button', { name: '转换为 EPUB', exact: true }) : c.locator('.action.convert')
      await btn.waitFor({ state: 'visible' })
      if (sheet) {
        const box = await btn.boundingBox()
        assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844 && box.height >= 44, 'sheet action fits viewport and touch target')
      } else {
        const [cover, box] = await Promise.all([c.locator('.cover').boundingBox(), btn.boundingBox()])
        assert.ok(box.y + box.height <= cover.y + cover.height && box.x >= cover.x, 'convert button inside the cover')
        for (const sel of ['.action.remove', '.action.upload']) {
          const b = await c.locator(sel).boundingBox()
          assert.ok(b.y + b.height <= cover.y + cover.height + 0.5, `${sel} not clipped`)
        }
      }
      await m.screenshot({ path: join(SHOTS, 'convert-mobile-menu.png') })
      await btn.tap()
      await m.locator('.toast', { hasText: '已转换为 EPUB' }).waitFor({ timeout: 60_000 })
      await m.screenshot({ path: join(SHOTS, 'convert-mobile-toast.png') })
      await mobile.close()
    })

    await step('package structure of every converted EPUB (mimetype first/stored, OPF, nav, NCX, cover)', async () => {
      const epubs = await idb(async (run) => {
        const rows = await run('books', 'readonly', s => s.getAll())
        return rows.filter(r => r.format === 'epub').map(r => {
          const u8 = new Uint8Array(r.file)
          let s = ''
          for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
          return { title: r.title, fileName: r.fileName, b64: btoa(s) }
        })
      })
      assert.equal(epubs.length, 4)
      for (const e of epubs) {
        const buf = Buffer.from(e.b64, 'base64')
        assert.equal(buf.readUInt32LE(0), 0x04034b50)
        assert.equal(buf.readUInt16LE(8), 0, 'mimetype stored')
        assert.equal(buf.readUInt16LE(28), 0, 'no extra field')
        assert.equal(buf.toString('latin1', 30, 38), 'mimetype')
        const zip = unzipSync(new Uint8Array(buf))
        assert.equal(Object.keys(zip)[0], 'mimetype')
        assert.match(strFromU8(zip['META-INF/container.xml']), /OEBPS\/content\.opf/)
        const opf = strFromU8(zip['OEBPS/content.opf'])
        assert.match(opf, /<dc:title>/)
        assert.match(opf, /properties="nav"/)
        assert.match(opf, /<spine toc="ncx"/)
        if (e.title !== '转换文本') assert.match(opf, /properties="cover-image"/, `${e.title}: cover-image`)
        assert.ok(zip['OEBPS/nav.xhtml'] && zip['OEBPS/toc.ncx'])
        const out = join(TMP, e.fileName)
        writeFileSync(out, buf)
        if (process.env.EPUBCHECK_JAR) {
          let report = ''
          try {
            report = execFileSync('java', ['-jar', process.env.EPUBCHECK_JAR, out, '-q'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
          } catch (err) { report = `${err.stdout}${err.stderr}` }
          const bad = report.split('\n').filter(l => /^(ERROR|FATAL)/.test(l))
          assert.equal(bad.length, 0, `epubcheck ${e.fileName}:\n${bad.slice(0, 8).join('\n')}`)
          console.log(`    epubcheck ${e.fileName}: 0 errors`)
        }
      }
    })

    assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`)
  } finally {
    await browser.close()
  }
  if (failed) process.exit(1)
  console.log(`PASS: format conversion e2e (screenshots in ${SHOTS})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1) })
}
