// 导入大文件分块写盘 (issue #14): 安卓 IPC 不能整本传字节, 按块 base64 交给原生层
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeBlobInChunks } from '../src/storage/chunkedWrite.ts'

const toBase64 = async blob => Buffer.from(await blob.arrayBuffer()).toString('base64')

function bytes(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 255
  return out
}

async function roundTrip(n, chunkBytes) {
  const data = bytes(n)
  const calls = []
  const parts = []
  const total = await writeBlobInChunks(new Blob([data]), async (offset, b64) => {
    calls.push(offset)
    parts.push(Buffer.from(b64, 'base64'))
  }, { chunkBytes, toBase64 })
  return { data, calls, total, out: Buffer.concat(parts) }
}

test('按块顺序写, 偏移连续, 拼回原文件', async () => {
  for (const [n, size] of [[10, 3], [9, 3], [1, 4], [1000, 1000], [70_001, 4096]]) {
    const { data, calls, total, out } = await roundTrip(n, size)
    assert.equal(total, n)
    assert.deepEqual(calls, Array.from({ length: Math.ceil(n / size) }, (_, i) => i * size))
    assert.deepEqual(new Uint8Array(out), data)
  }
})

test('空文件也写一次 (原生层据此建文件)', async () => {
  const { calls, total, out } = await roundTrip(0, 4)
  assert.deepEqual(calls, [0])
  assert.equal(total, 0)
  assert.equal(out.length, 0)
})

test('不整块读文件, 写失败立即停止', async () => {
  const blob = new Blob([bytes(100)])
  blob.arrayBuffer = () => { throw new Error('整本读进内存了') }
  const seen = []
  await assert.rejects(writeBlobInChunks(blob, async offset => {
    seen.push(offset)
    if (offset === 20) throw new Error('disk full')
  }, { chunkBytes: 10, toBase64 }), /disk full/)
  assert.deepEqual(seen, [0, 10, 20])
})
