import assert from 'node:assert/strict'

/** APK incremental packaging can leave a whole obsolete native library as ZIP padding. */
export function verifyApkLayout(data) {
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { eocd = i; break }
  }
  assert.ok(eocd >= 0, 'APK ZIP directory missing')
  const count = data.readUInt16LE(eocd + 10), central = data.readUInt32LE(eocd + 16)
  assert.ok(count > 0 && count < 65535 && central < eocd, 'unsupported APK ZIP layout')
  const spans = []
  let cursor = central
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50, 'invalid APK central entry')
    const size = data.readUInt32LE(cursor + 20), local = data.readUInt32LE(cursor + 42)
    assert.equal(data.readUInt32LE(local), 0x04034b50, 'invalid APK local entry')
    const end = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28) + size
    assert.ok(end <= central, 'APK entry overlaps directory')
    spans.push([local, end])
    cursor += 46 + data.readUInt16LE(cursor + 28) + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32)
  }
  spans.sort((a,b)=>a[0]-b[0])
  let previous = 0, unindexedBytes = 0, largestGap = 0
  for (const [start,end] of [...spans,[central,central]]) {
    assert.ok(start >= previous, 'overlapping APK entries')
    const gap = start - previous
    largestGap = Math.max(largestGap,gap); unindexedBytes += gap; previous = end
  }
  // Allow alignment, data descriptors and normal signing blocks, reject megabytes of stale padding.
  assert.ok(largestGap <= 1024 * 1024, `APK contains ${largestGap} bytes of unused padding; clean Android packaging outputs and rebuild`)
  return { entries: count, unindexedBytes, largestGap }
}
