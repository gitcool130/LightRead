import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const moduleUrl = new URL('../src/services/nativeTts.ts', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === moduleUrl && specifier === '../i18n') {
      return { shortCircuit: true, url: 'data:text/javascript,export const t = key => key' }
    }
    return next(specifier, context)
  },
})
const { nativeTtsAvailable, listNativeVoices, nativeTtsSynthesize, nativeTtsStop } = await import(moduleUrl)
hook.deregister()

const calls = []
const bus = new EventTarget()
globalThis.window = bus
const answer = (id, result) => bus.dispatchEvent(new CustomEvent('lightread-native-tts', { detail: { id, ok: true, result } }))
const fail = (id, code) => bus.dispatchEvent(new CustomEvent('lightread-native-tts', { detail: { id, ok: false, error: { code, message: 'native detail' } } }))
const bridge = {
  request(id, method, payload) {
    calls.push({ id, method, payload: JSON.parse(payload) })
    if (method === 'cancel') answer(id, null)
  },
}
const wav = new Uint8Array(46)
new TextEncoder().encodeInto('RIFF', wav)
new TextEncoder().encodeInto('WAVE', wav.subarray(8))
const audio = { audioBase64: Buffer.from(wav).toString('base64'), mimeType: 'audio/wav' }
const voices = { voices: [{ id: 'zh-local', name: 'zh-local', lang: 'zh-CN', local: true, isDefault: false }], defaultVoiceId: 'zh-local' }

function reset() { nativeTtsStop(); calls.length = 0; bus.LightReadNativeTts = bridge }

test('native bridge absence is explicit and can recover when an engine bridge appears', async () => {
  delete bus.LightReadNativeTts
  assert.equal(nativeTtsAvailable(), false)
  await assert.rejects(listNativeVoices(), { code: 'NO_ENGINE', message: 'tts.nativeNoEngine' })
  reset()
  assert.equal(nativeTtsAvailable(), true)
  const listed = listNativeVoices()
  answer(calls[0].id, voices)
  assert.equal((await listed)[0].isDefault, true)
})

test('native replies match request IDs and synthesis returns the exact WAV bytes', async () => {
  reset()
  const synthesis = nativeTtsSynthesize('你好。', 'zh-local', 1.5)
  const listed = listNativeVoices()
  assert.deepEqual(calls[0].payload, { text: '你好。', voiceId: 'zh-local', rate: 1.5 })
  answer(calls[1].id, voices)
  answer(calls[0].id, audio)
  assert.equal((await listed)[0].id, 'zh-local')
  const blob = await synthesis
  assert.equal(blob.type, 'audio/wav')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), wav)
})

test('native errors explain absent engines and voice data and do not poison retries', async () => {
  reset()
  for (const [code, key] of [['NO_ENGINE', 'tts.nativeNoEngine'], ['NO_OFFLINE_VOICE', 'tts.nativeNoVoice'], ['TIMEOUT', 'tts.nativeTimeout']]) {
    const synthesis = nativeTtsSynthesize('你好。')
    fail(calls.at(-1).id, code)
    await assert.rejects(synthesis, { code, message: key })
  }
  const retry = nativeTtsSynthesize('你好。')
  answer(calls.at(-1).id, audio)
  assert.equal((await retry).size, wav.length)
})

test('stop cancels only captured synthesis IDs and ignores their late replies', async () => {
  reset()
  const old = nativeTtsSynthesize('旧会话。')
  const oldId = calls[0].id
  const rejected = assert.rejects(old, { code: 'CANCELLED' })
  nativeTtsStop()
  const next = nativeTtsSynthesize('新会话。')
  const nextId = calls.at(-1).id
  assert.deepEqual(calls.filter(c => c.method === 'cancel').map(c => c.payload), [{ requestId: oldId }])
  answer(oldId, audio)
  answer(nextId, audio)
  await rejected
  assert.equal((await next).size, wav.length)
})

test('native malformed audio is a failure rather than successful silent playback', async () => {
  reset()
  const synthesis = nativeTtsSynthesize('你好。')
  answer(calls[0].id, { audioBase64: Buffer.from('not audio').toString('base64'), mimeType: 'audio/wav' })
  await assert.rejects(synthesis, { code: 'FAILED', message: 'tts.nativeFailed' })
})
