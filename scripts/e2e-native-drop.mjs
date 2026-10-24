/** Run against Vite dev (TAURI_ENV_PLATFORM=linux npm run dev).
 * Uses the real Tauri JS event listener with mocked IPC, and real parsing/IndexedDB.
 * Rust filesystem behavior is covered by cargo test library_import.
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(String(error)))
async function waitForBooks(count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate(async () => (await window.__books()).length) === count) return
    await page.waitForTimeout(100)
  }
  assert.equal(await page.evaluate(async () => (await window.__books()).length), count)
}
try {
  await page.goto(`${process.env.E2E_BASE ?? 'http://localhost:5173'}/#/library`)
  await page.locator('.library').waitFor()
  await page.evaluate(async () => {
    const { getStorage } = await import('/src/storage/index.ts')
    const storage = await getStorage()
    const { router } = await import('/src/router/index.ts')
    const { startNativeDrop } = await import('/src/services/nativeDrop.ts')
    const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js')
    const { emit } = await import('/node_modules/@tauri-apps/api/event.js')
    const staged = new Map()
    const bytes = path => new Blob([path.endsWith('.epub') ? 'broken epub' : `${path.split('/').pop()}\n\n第一章\n\n测试正文。`])
    let release
    window.__holdImport = false
    window.__resumeImport = () => release?.()
    storage.stageBookFromPath = async path => {
      if (window.__holdImport) {
        window.__holdImport = false
        await new Promise(resolve => { release = resolve })
      }
      if (path.includes('missing')) throw new Error('fixture missing')
      const ref = { kind: 'local-file', root: '', rel: path, blob: async () => bytes(path) }
      staged.set(path, ref)
      return ref
    }
    storage.addBookFromStaged = async (meta, ref, cover) => {
      const id = await storage.addBook(meta, await ref.blob(), cover)
      staged.delete(ref.rel)
      return id
    }
    storage.discardStaged = async ref => { staged.delete(ref.rel) }
    window.__stagedCount = () => staged.size
    window.__books = () => storage.listBooks()
    const entry = path => ({ path, name: path.split('/').pop(), absPath: path, size: 100 })
    mockWindows('main')
    mockIPC(async (cmd, args) => {
      if (cmd === 'library_import_scan') {
        const directory = args.paths.includes('/folder')
        return {
          name: directory ? 'folder' : '', hasDirectories: directory, truncated: false, errors: [],
          entries: directory ? ['/folder/folder-book.txt', '/folder/folder-book.md', '/folder/next.txt'].map(entry) : args.paths.map(entry),
        }
      }
      if (cmd === 'agent_engine_status') return { engine: args.engine, found: false, compatible: false, authenticated: false, path: '', version: '', reason: '', approvalPosture: '' }
      throw new Error(`Unexpected IPC: ${cmd}`)
    }, { shouldMockEvents: true })
    window.__stopDrop = startNativeDrop(router, error => { throw error })
    window.__drop = paths => emit('tauri://drag-drop', { paths, position: { x: 80, y: 80 } })
    window.__drag = type => emit(`tauri://drag-${type}`, { paths: ['/single.txt'], position: { x: 80, y: 80 } })
    window.__navigate = path => router.push(path)
  })
  // Exercise the real filesystem storage orchestration: failed indexing must remove the
  // renamed book and cover, without deleting or overwriting the user's original source.
  const rollback = await page.evaluate(async () => {
    const { TauriStorage } = await import('/src/storage/tauri.ts')
    const storage = new TauriStorage()
    const calls = []
    storage.libraryFile = async (cmd, args) => { calls.push({ cmd, ...args }) }
    storage.insertBook = async () => { throw new Error('index failed') }
    try {
      await storage.addBookFromStaged({ fileName: 'book.txt' }, { rel: 'books/import.part' })
      throw new Error('expected indexing failure')
    } catch (error) {
      return { message: error.message, calls }
    }
  })
  assert.equal(rollback.message, 'index failed')
  assert.deepEqual(rollback.calls.map(c => c.cmd), ['library_file_rename', 'library_file_remove', 'library_file_remove'])
  assert.equal(rollback.calls[0].to, rollback.calls[1].rel)
  assert.match(rollback.calls[2].rel, /^covers\//)
  // Registration dynamically loads the SDK; remote dev servers can take longer.
  for (let attempt = 0; attempt < 100; attempt++) {
    await page.evaluate(() => window.__drag('enter'))
    if (await page.locator('.drop-hint').isVisible()) break
    await page.waitForTimeout(100)
  }
  assert.ok(await page.locator('.drop-hint').isVisible(), JSON.stringify(errors))
  await page.evaluate(() => window.__drag('leave'))
  await page.locator('.drop-hint').waitFor({ state: 'hidden' })
  // WebKit can emit DOM dragover while Tauri consumes the corresponding drop.
  await page.locator('.library').dispatchEvent('dragover')
  await page.evaluate(() => window.__drop(['/single.txt']))
  await waitForBooks(1)
  await page.locator('.drop-hint').waitFor({ state: 'hidden' })
  // A failed copy and a parse failure must not prevent the last file importing.
  await page.evaluate(() => window.__drop(['/missing.txt', '/broken.epub', '/batch-a.txt', '/batch-b.txt']))
  await waitForBooks(3)
  await page.waitForFunction(() => window.__stagedCount() === 0)
  await page.locator('.import-bar').waitFor({ state: 'hidden' })
  // A second drop during an import is retained.
  await page.evaluate(() => { window.__holdImport = true; return window.__drop(['/slow.txt']) })
  await page.locator('.import-bar').waitFor()
  await page.evaluate(() => window.__drop(['/queued.txt']))
  await page.evaluate(() => window.__resumeImport())
  await waitForBooks(5)
  // Folder review applies the existing format preference, then imports via native staging.
  await page.evaluate(() => window.__drop(['/folder']))
  await page.locator('.folder-dialog').waitFor()
  await page.locator('.folder-dialog').getByRole('button', { name: /添加 2 本/ }).click()
  await waitForBooks(7)
  const importedNames = await page.evaluate(async () => (await window.__books()).map(b => b.fileName))
  assert.ok(importedNames.includes('folder-book.txt'), JSON.stringify(importedNames))
  await page.evaluate(() => window.__drop(['/folder']))
  await page.locator('.folder-dialog').waitFor()
  await page.locator('.folder-dialog').getByRole('button', { name: /取消/ }).click()
  assert.equal(await page.evaluate(async () => (await window.__books()).length), 7)
  // Drop on another page navigates to library; papers stay classified as papers.
  await page.evaluate(() => window.__navigate('/settings'))
  await page.evaluate(() => window.__drop(['/from-settings.txt']))
  await waitForBooks(8)
  assert.match(page.url(), /#\/library$/)
  await page.evaluate(() => window.__navigate('/papers'))
  await page.evaluate(() => window.__drop(['/paper.txt']))
  await waitForBooks(9)
  assert.ok(await page.evaluate(async () => (await window.__books()).some(b => b.fileName === 'paper.txt' && b.kind === 'paper')))
  await page.evaluate(() => window.__stopDrop())
  await page.evaluate(() => window.__drop(['/after-stop.txt']))
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(async () => (await window.__books()).length), 9)
  await page.waitForFunction(() => window.__stagedCount() === 0)
  await page.locator('.import-bar').waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log('Native drop UI: single/batch/failure/queue/folder/cancel/navigation/papers/disposal passed')
} finally {
  await browser.close()
}
