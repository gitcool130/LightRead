import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyApkLayout } from './apk-layout.mjs'
function fixture(padding) {
 const local = Buffer.alloc(34); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(4,18)
 const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(4,20)
 const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(46,12); end.writeUInt32LE(local.length+padding,16)
 return Buffer.concat([local,Buffer.alloc(padding),central,end])
}
test('allows ordinary APK signing/alignment space',()=>assert.equal(verifyApkLayout(fixture(16384)).largestGap,16384))
test('rejects stale incremental ZIP padding even when central directory is valid',()=>assert.throws(()=>verifyApkLayout(fixture(2*1024*1024)),/unused padding/))
test('rejects truncated ZIP',()=>assert.throws(()=>verifyApkLayout(fixture(0).subarray(0,30)),/directory missing/))
