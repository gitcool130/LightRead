import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { ref } from 'vue'
import { handleNativeDragDrop, nativeDragging, nativeDropQueue } from '../src/services/nativeDrop.ts'

beforeEach(() => { nativeDragging.value = false; nativeDropQueue.value = [] })
function router(path = '/library') {
  const pushed = []
  return { currentRoute: ref({ path }), pushed, push: async path => { pushed.push(path) } }
}

test('native enter/over/leave update the drop affordance without importing', () => {
  const r = router()
  handleNativeDragDrop({ type: 'enter', paths: ['/book.txt'], position: { x: 0, y: 0 } }, r)
  assert.equal(nativeDragging.value, true)
  handleNativeDragDrop({ type: 'over', position: { x: 10, y: 10 } }, r)
  assert.equal(nativeDragging.value, true)
  handleNativeDragDrop({ type: 'leave' }, r)
  assert.equal(nativeDragging.value, false)
  assert.deepEqual(nativeDropQueue.value, [])
})

test('single, batch and mixed folder drops are queued once, preserving batch boundaries', () => {
  const r = router('/papers')
  for (const paths of [['/a.pdf'], ['/b.pdf', '/c.epub'], ['/folder', '/d.txt']]) {
    handleNativeDragDrop({ type: 'drop', paths, position: { x: 1, y: 1 } }, r)
  }
  assert.deepEqual(nativeDropQueue.value, [['/a.pdf'], ['/b.pdf', '/c.epub'], ['/folder', '/d.txt']])
  assert.deepEqual(r.pushed, [])
  assert.equal(nativeDragging.value, false)
})

test('dropping over other pages navigates to the library and retains the pending import', () => {
  const r = router('/settings')
  handleNativeDragDrop({ type: 'drop', paths: ['/中文 空格.txt'] }, r)
  assert.deepEqual(r.pushed, ['/library'])
  assert.deepEqual(nativeDropQueue.value, [['/中文 空格.txt']])
})

test('empty drop does not navigate or schedule an import', () => {
  const r = router('/settings')
  handleNativeDragDrop({ type: 'drop', paths: [] }, r)
  assert.deepEqual(r.pushed, [])
  assert.deepEqual(nativeDropQueue.value, [])
})
