/**
 * 损坏封面修复 (src/services/coverRepair.ts): 空文件 / 缺失 / 非图片封面回退文字封面,
 * 从书籍文件重新生成后写回; 书里取不到封面就清标记; 暂时出错保留标记; 每本每次运行只修一次.
 *
 *   npm run test:cover-repair
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoverResolver, isUsableCoverBytes } from '../src/services/coverRepair.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

test('accepts common image headers, rejects empty and non-image bytes', () => {
  assert.equal(isUsableCoverBytes(JPEG), true)
  assert.equal(isUsableCoverBytes(PNG), true)
  assert.equal(isUsableCoverBytes(WEBP), true)
  assert.equal(isUsableCoverBytes(new Uint8Array()), false)
  assert.equal(isUsableCoverBytes(new Uint8Array(4096)), false)
  assert.equal(isUsableCoverBytes(new TextEncoder().encode('<html>not an image</html>')), false)
})

/** 假书库: covers 存字节, getCoverUrl 与真实存储一样对不可用的封面返回 undefined */
function fakeStorage(covers) {
  const calls = { set: 0, clear: 0 }
  const flags = new Map()
  return {
    calls,
    flags,
    covers,
    async getCoverUrl(id) {
      const bytes = covers.get(id)
      return bytes && isUsableCoverBytes(bytes) ? `blob:${id}:${calls.set}` : undefined
    },
    async setCover(id, blob) {
      if (!blob.size) return
      calls.set++
      covers.set(id, new Uint8Array(await blob.arrayBuffer()))
      flags.set(id, true)
    },
    async clearCover(id) {
      calls.clear++
      covers.delete(id)
      flags.set(id, false)
    },
  }
}

const book = (id, hasCover = true) => ({ id, hasCover, title: id, author: '', format: 'pdf', fileName: `${id}.pdf`, tags: [], addedAt: 0 })

test('valid cover is returned without touching the book file', async () => {
  const storage = fakeStorage(new Map([['a', JPEG]]))
  let regenerated = 0
  const resolve = createCoverResolver({ storage, regenerate: async () => { regenerated++ } })
  assert.match(await resolve(book('a')), /^blob:a/)
  assert.equal(regenerated, 0)
})

test('zero-byte cover with hasCover is regenerated from the book and written back', async () => {
  const storage = fakeStorage(new Map([['a', new Uint8Array()]]))
  const b = book('a')
  const resolve = createCoverResolver({ storage, regenerate: async () => new Blob([JPEG]) })
  const url = await resolve(b)
  assert.ok(url, 'regenerated cover gets a url')
  assert.equal(storage.calls.set, 1)
  assert.deepEqual(storage.covers.get('a'), JPEG)
  assert.equal(b.hasCover, true)
  // 下次 (例如重启后) 直接用已修复的封面
  const again = createCoverResolver({ storage, regenerate: async () => { throw new Error('should not regenerate') } })
  assert.ok(await again(b))
})

test('missing or non-image cover is repaired the same way', async () => {
  const storage = fakeStorage(new Map([['bad', new TextEncoder().encode('garbage bytes')]]))
  const resolve = createCoverResolver({ storage, regenerate: async () => new Blob([PNG]) })
  assert.ok(await resolve(book('bad')))
  assert.ok(await resolve(book('missing')))
  assert.equal(storage.calls.set, 2)
})

test('book without an extractable cover clears the flag and falls back to text', async () => {
  const storage = fakeStorage(new Map([['a', new Uint8Array()]]))
  const b = book('a')
  const resolve = createCoverResolver({ storage, regenerate: async () => undefined })
  assert.equal(await resolve(b), undefined)
  assert.equal(storage.calls.clear, 1)
  assert.equal(storage.flags.get('a'), false)
  assert.equal(b.hasCover, false)
})

test('empty regenerated blob is not written as a cover', async () => {
  const storage = fakeStorage(new Map([['a', new Uint8Array()]]))
  const resolve = createCoverResolver({ storage, regenerate: async () => new Blob([]) })
  assert.equal(await resolve(book('a')), undefined)
  assert.equal(storage.calls.set, 0)
  assert.equal(storage.calls.clear, 1)
})

test('regeneration error keeps the flag and is not retried in the same run', async () => {
  const storage = fakeStorage(new Map([['a', new Uint8Array()]]))
  const b = book('a')
  let attempts = 0
  const warn = console.warn
  console.warn = () => {}
  try {
    const resolve = createCoverResolver({ storage, regenerate: async () => { attempts++; throw new Error('wasm not loaded') } })
    assert.equal(await resolve(b), undefined)
    assert.equal(await resolve(b), undefined)
  } finally {
    console.warn = warn
  }
  assert.equal(attempts, 1)
  assert.equal(storage.calls.clear, 0)
  assert.equal(b.hasCover, true, 'a transient failure must not drop the cover flag')
})

test('concurrent refreshes share one repair', async () => {
  const storage = fakeStorage(new Map([['a', new Uint8Array()]]))
  let attempts = 0
  const resolve = createCoverResolver({
    storage,
    regenerate: async () => { attempts++; await new Promise(r => setTimeout(r, 10)); return new Blob([JPEG]) },
  })
  const [u1, u2] = await Promise.all([resolve(book('a')), resolve(book('a'))])
  assert.ok(u1)
  assert.equal(u1, u2)
  assert.equal(attempts, 1)
})

test('books without a cover flag are left alone', async () => {
  const storage = fakeStorage(new Map())
  const resolve = createCoverResolver({ storage, regenerate: async () => { throw new Error('no') } })
  assert.equal(await resolve(book('a', false)), undefined)
  assert.equal(storage.calls.clear, 0)
})
