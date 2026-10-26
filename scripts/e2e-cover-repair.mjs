// 损坏封面修复端到端 (网页 IndexedDB 后端, 与桌面 / App 共用 services/coverRepair.ts 与书库 store):
// 导入 PDF → 把封面改成 0 字节 / 非图片 → 重新打开后从 PDF 第一页重新生成;
// TXT 等取不到封面的书带着「有封面」标记 → 清标记并显示文字封面. 阅读进度不受影响.
//
//   npm run build && npx vite preview --port 4173 --strictPort &
//   node scripts/e2e-cover-repair.mjs
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'
const TMP = '/tmp/lightread-e2e-cover'
mkdirSync(TMP, { recursive: true })

const stream = '/F1 32 Tf 80 600 Td (Cover Repair PDF) Tj'
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${stream.length + 10} >>\nstream\nBT\n${stream}\nET\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]
let pdf = '%PDF-1.4\n'
const offsets = objs.map((body, i) => {
  const at = pdf.length
  pdf += `${i + 1} 0 obj ${body} endobj\n`
  return at
})
const xref = pdf.length
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const pdfPath = join(TMP, '语文六年级上册.pdf')
writeFileSync(pdfPath, pdf)
const txtPath = join(TMP, '无封面.txt')
writeFileSync(txtPath, '第一章\n\n' + '正文内容。'.repeat(200), 'utf-8')

const browser = await chromium.launch()
const page = await browser.newPage()
let failed = 0
const step = async (name, fn) => {
  try {
    await fn()
    console.log('✅', name)
  } catch (e) {
    failed++
    console.log('❌', name, '—', e.message.split('\n')[0])
    await page.screenshot({ path: join(TMP, `fail-${name.replace(/\W+/g, '_')}.png`) })
  }
}

/** 直接改 IndexedDB 里的书目 (模拟设备上已经损坏的数据) */
const patchBook = (title, patch) => page.evaluate(([title, patch]) => new Promise((resolve, reject) => {
  const open = indexedDB.open('lightread')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const tx = open.result.transaction('books', 'readwrite')
    const store = tx.objectStore('books')
    const all = store.getAll()
    all.onsuccess = () => {
      const row = all.result.find(r => r.title === title)
      if (!row) return reject(new Error(`no book ${title}`))
      const next = { ...row, ...patch }
      if (patch.cover === 'EMPTY') next.cover = new ArrayBuffer(0)
      if (patch.cover === 'GARBAGE') next.cover = new TextEncoder().encode('not an image at all').buffer
      store.put(next)
    }
    tx.oncomplete = () => { open.result.close(); resolve() }
    tx.onerror = () => reject(tx.error)
  }
}), [title, patch])

const readBook = title => page.evaluate(title => new Promise((resolve, reject) => {
  const open = indexedDB.open('lightread')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const all = open.result.transaction('books').objectStore('books').getAll()
    all.onsuccess = () => {
      const row = all.result.find(r => r.title === title)
      open.result.close()
      if (!row) return resolve(null)
      const bytes = row.cover ? new Uint8Array(row.cover instanceof Blob ? [] : row.cover) : new Uint8Array()
      resolve({ hasCover: row.hasCover, coverSize: bytes.length, head: [...bytes.slice(0, 3)], progress: row.progress ?? null })
    }
  }
}), title)

const card = title => page.locator('.book-card', { hasText: title })
const coverImgVisible = title => card(title).locator('.cover img').first().waitFor({ state: 'visible', timeout: 15000 })

await step('导入 PDF 与 TXT', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.waitForSelector('text=书架还是空的', { timeout: 8000 })
  await page.setInputFiles('input[type=file][multiple]', [pdfPath, txtPath])
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 15000 })
  await coverImgVisible('语文六年级上册')
})

const pdfTitle = '语文六年级上册'
await step('0 字节封面: 重新打开后从 PDF 第一页重新生成', async () => {
  await patchBook(pdfTitle, { cover: 'EMPTY', hasCover: true, progress: 0.42 })
  await page.reload({ waitUntil: 'networkidle' })
  await coverImgVisible(pdfTitle)
  const row = await readBook(pdfTitle)
  if (!row.hasCover || row.coverSize === 0) throw new Error(`cover not repaired: ${JSON.stringify(row)}`)
  if (row.head.join(',') !== '255,216,255') throw new Error(`not a JPEG: ${row.head}`)
  if (row.progress !== 0.42) throw new Error(`progress changed: ${row.progress}`)
})

await step('修复后重启: 封面仍正常', async () => {
  await page.reload({ waitUntil: 'networkidle' })
  await coverImgVisible(pdfTitle)
})

await step('非空但不是图片的封面: 同样修复', async () => {
  await patchBook(pdfTitle, { cover: 'GARBAGE', hasCover: true })
  await page.reload({ waitUntil: 'networkidle' })
  await coverImgVisible(pdfTitle)
  const row = await readBook(pdfTitle)
  if (row.head.join(',') !== '255,216,255') throw new Error(`not repaired: ${JSON.stringify(row)}`)
})

await step('取不到封面的书: 清标记, 显示文字封面', async () => {
  await patchBook('无封面', { cover: 'EMPTY', hasCover: true })
  await page.reload({ waitUntil: 'networkidle' })
  await card('无封面').locator('.cover-fallback').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(async () => {
    const db = await new Promise(r => { const o = indexedDB.open('lightread'); o.onsuccess = () => r(o.result) })
    const rows = await new Promise(r => { const q = db.transaction('books').objectStore('books').getAll(); q.onsuccess = () => r(q.result) })
    db.close()
    return rows.find(x => x.title === '无封面')?.hasCover === false
  }, null, { timeout: 10000 })
  if (await card('无封面').locator('.cover img').count()) throw new Error('broken img still rendered')
})

await page.screenshot({ path: join(TMP, 'library.png') })
await browser.close()
console.log(failed ? `\n${failed} step(s) failed` : '\nall cover repair steps passed')
process.exit(failed ? 1 : 0)
