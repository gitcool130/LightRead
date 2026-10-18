import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// Exercise the real scheduler with controllable native synthesis and playback.
const state = {
  settings: { ttsEngine: 'local', localVoiceId: 50, ttsRate: 1, ttsVoice: '' },
  synthesize: () => Promise.resolve(new Blob(['wav'])),
  warmup: () => Promise.resolve(),
  play: () => Promise.resolve('end'),
  played: [],
  dismissed: 0,
  spoken: [],
  notices: [],
  nativeAvailable: false,
  nativeVoices: [{ id: 'zh-local', name: 'zh-local', lang: 'zh-CN', local: true, isDefault: true }],
  nativeCalls: [],
  nativeSynth: async text => new Blob([text]),
  nativeVoiceQuery: null,
}
globalThis.__ttsTest = state
globalThis.speechSynthesis = {
  cancel() {}, pause() {}, resume() {},
  getVoices: () => [{ name: 'system', lang: 'zh-CN' }],
  speak(utterance) { state.spoken.push(utterance.text); utterance.onend() },
}
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text }
}

const ttsUrl = new URL('../src/services/tts.ts', import.meta.url).href
const modules = {
  '../stores/settings': 'export const useSettings = () => globalThis.__ttsTest.settings',
  './toast': `export const toast = (...args) => {
    globalThis.__ttsTest.notices.push(args)
    return () => { globalThis.__ttsTest.dismissed++ }
  }`,
  '../i18n': 'export const t = key => key',
  './localTts': `export const localTtsAvailable = () => true;
    export const localTtsWarmup = () => globalThis.__ttsTest.warmup();
    export const localTtsSynthesize = (...args) => globalThis.__ttsTest.synthesize(...args);
    export const localPack = { crashed: false };
    export const isLocalCrashError = e => String(e?.message ?? e).includes('LOCAL_TTS_CRASHED')`,
  './edgeTts': `export const edgeAvailable = () => true;
    export const edgePause = () => {};
    export const edgeResume = () => {};
    export const edgeStop = () => {};
    export const edgeSynthesize = (...args) => globalThis.__ttsTest.synthesize(...args);
    export const playAudio = async blob => { globalThis.__ttsTest.played.push(blob); return globalThis.__ttsTest.play(blob) }`,
  './nativeTts': `export class NativeTtsError extends Error { constructor(code) { super(code); this.code = code } }
    export const nativeTtsAvailable = () => globalThis.__ttsTest.nativeAvailable;
    export const listNativeVoices = async () => globalThis.__ttsTest.nativeVoiceQuery
      ? globalThis.__ttsTest.nativeVoiceQuery() : globalThis.__ttsTest.nativeVoices;
    export const nativeTtsStop = () => {};
    export const nativeTtsSynthesize = (...args) => {
      globalThis.__ttsTest.nativeCalls.push(args); return globalThis.__ttsTest.nativeSynth(...args)
    }`,
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ttsUrl && modules[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
const {
  speakText, stopSpeech, resetEdgeFailure, prefetchSpeech, pauseSpeech, resumeSpeech,
  splitSpeechText, forgetLocalModel, LOCAL_LOADING_HINT_MS,
  getVoices, listVoicesSorted, speak, systemSpeechAvailable,
} = await import(ttsUrl)
hook.deregister()

function reset() {
  stopSpeech()
  resetEdgeFailure()
  state.settings.ttsEngine = 'local'
  state.nativeAvailable = false
  state.nativeCalls.length = 0
  state.nativeSynth = async text => new Blob([text])
  state.nativeVoiceQuery = null
  state.played.length = 0
  state.spoken.length = 0
  state.notices.length = 0
  state.dismissed = 0
  state.play = () => Promise.resolve('end')
  state.warmup = () => Promise.resolve()
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** 可控合成: 记录调用顺序, 每次调用需手动 resolve; 同时统计最大并发 */
function controlledSynth() {
  const calls = []
  let inFlight = 0
  const ctl = { calls, maxInFlight: 0 }
  state.synthesize = text => {
    const d = Promise.withResolvers()
    inFlight++
    ctl.maxInFlight = Math.max(ctl.maxInFlight, inFlight)
    calls.push({ text, resolve: () => { inFlight--; d.resolve(new Blob([text])) }, reject: e => { inFlight--; d.reject(e) } })
    return d.promise
  }
  return ctl
}

test('plays a completed offline synthesis', async () => {
  reset()
  state.synthesize = async () => new Blob(['wav'])
  assert.equal(await speakText('hello'), 'end')
  assert.equal(state.played.length, 1)
})

test('stop during offline synthesis prevents late playback', async () => {
  reset()
  const pending = Promise.withResolvers()
  state.synthesize = () => pending.promise
  const speech = speakText('old paragraph')
  stopSpeech()
  pending.resolve(new Blob(['old']))
  assert.equal(await speech, 'cancelled')
  assert.equal(state.played.length, 0)
  assert.equal(state.spoken.length, 0)
})

test('a stopped failure does not fall back or poison a new session', async () => {
  reset()
  const pending = Promise.withResolvers()
  state.synthesize = () => pending.promise
  const old = speakText('old paragraph')
  stopSpeech()
  // 停止发生在合成真正开始之前时, 队列直接丢弃该请求, 这个 promise 可能无人等待
  pending.promise.catch(() => {})
  pending.reject(new Error('cancelled session failed'))
  assert.equal(await old, 'cancelled')
  assert.equal(state.notices.length, 0)
  assert.equal(state.spoken.length, 0)
  state.synthesize = async () => new Blob(['new'])
  assert.equal(await speakText('new paragraph'), 'end')
  assert.equal(state.played.length, 1)
})

test('new playback survives completion of an older cancelled synthesis', async () => {
  reset()
  const pending = Promise.withResolvers()
  state.synthesize = () => pending.promise
  const old = speakText('old paragraph')
  stopSpeech()
  state.synthesize = async () => new Blob(['new'])
  assert.equal(await speakText('new paragraph'), 'end')
  pending.resolve(new Blob(['old']))
  assert.equal(await old, 'cancelled')
  assert.equal(state.played.length, 1)
  assert.equal(await state.played[0].text(), 'new')
})

test('splitSpeechText keeps all text, splits on sentences and caps chunk length', () => {
  const text = '夜色像一块浸了水的墨布，慢慢压下来。她推开门！风很大？' +
    '这是一个非常非常长的句子，'.repeat(12) + '结束。Pi is 3.14 here. Next one.'
  const chunks = splitSpeechText(text, 40)
  assert.ok(chunks.length > 3)
  const squash = x => x.replace(/\s+/g, '')
  assert.equal(squash(chunks.join('')), squash(text), 'no text lost (whitespace aside)')
  for (const c of chunks) assert.ok(c.length <= 40, `chunk too long: ${c.length}`)
  assert.ok(chunks[0].length <= 20, 'first chunk is short so audio starts quickly')
  assert.ok(chunks.some(c => c.includes('3.14')), 'decimal point is not a sentence break')
  assert.deepEqual(splitSpeechText('短句。'), ['短句。'])
  assert.deepEqual(splitSpeechText('……'), [])
})

test('long paragraph is synthesized sentence by sentence and played while the rest synthesizes', async () => {
  reset()
  const ctl = controlledSynth()
  const plays = []
  state.play = blob => { const d = Promise.withResolvers(); plays.push(d); return d.promise }
  const para = '第一句话在这里。第二句话也在这里，而且稍微长一点点。第三句话。' +
    '第四句话会比较长一些，用来确认切块之后依然按顺序播放。'
  const speech = speakText(para)
  await tick()
  assert.equal(ctl.calls.length, 1, 'only one synthesis runs at a time')
  ctl.calls[0].resolve()
  await tick()
  assert.equal(plays.length, 1, 'first chunk plays as soon as it is ready')
  assert.equal(ctl.calls.length, 2, 'next chunk synthesizes during playback')
  // 后续块在第一块播放期间就合成完成
  while (ctl.calls.some(c => !c.done)) {
    for (const c of ctl.calls) if (!c.done) { c.done = true; c.resolve() }
    await tick()
  }
  while (plays.some(p => !p.settled)) {
    for (const p of plays) if (!p.settled) { p.settled = true; p.resolve('end') }
    await tick()
  }
  assert.equal(await speech, 'end')
  assert.equal(ctl.maxInFlight, 1)
  const playedText = (await Promise.all(state.played.map(b => b.text()))).join('')
  assert.equal(playedText, para)
})

test('current paragraph is synthesized before prefetched upcoming paragraphs', async () => {
  reset()
  const ctl = controlledSynth()
  // 预取在当前段之前调用也不影响顺序
  prefetchSpeech('下一段。', 1)
  prefetchSpeech('再下一段。', 2)
  const current = '当前第一句。当前第二句，稍微长一些的内容在这里，再多写一些字凑够长度吧。' +
    '当前第三句也比较长，再多写几个字，让它和上一句分开成为单独的一块内容。'
  const parts = splitSpeechText(current)
  assert.ok(parts.length >= 2)
  const speech = speakText(current)
  for (let i = 0; i < 20 && ctl.calls.length < parts.length + 2; i++) {
    await tick()
    ctl.calls.at(-1).resolve()
  }
  await tick()
  ctl.calls.at(-1).resolve()
  await speech
  assert.deepEqual(ctl.calls.map(c => c.text), [...parts, '下一段。', '再下一段。'])
  assert.equal(ctl.maxInFlight, 1)
})

test('a prefetched paragraph is reused without a second synthesis', async () => {
  reset()
  const ctl = controlledSynth()
  prefetchSpeech('预取的一段。')
  await tick()
  ctl.calls[0].resolve()
  await tick()
  const speech = speakText('预取的一段。')
  assert.equal(await speech, 'end')
  assert.equal(ctl.calls.length, 1)
  assert.equal(state.played.length, 1)
})

test('stop drops queued prefetches so a new session does not wait behind them', async () => {
  reset()
  const ctl = controlledSynth()
  prefetchSpeech('旧的一段。', 1)
  prefetchSpeech('旧的二段。', 2)
  prefetchSpeech('旧的三段。', 3)
  await tick()
  assert.equal(ctl.calls.length, 1)
  stopSpeech()
  const speech = speakText('新的段落。')
  await tick()
  assert.deepEqual(ctl.calls.map(c => c.text), ['旧的一段。', '新的段落。'],
    'queued stale work never reaches the engine; new session starts immediately')
  ctl.calls[1].resolve()
  assert.equal(await speech, 'end')
  ctl.calls[0].resolve()
  await tick()
  assert.equal(ctl.calls.length, 2)
  assert.equal(state.played.length, 1)
})

test('pause between chunks holds the next chunk until resume', async () => {
  reset()
  state.synthesize = async text => new Blob([text])
  const first = Promise.withResolvers()
  let calls = 0
  state.play = () => (++calls === 1 ? first.promise : Promise.resolve('end'))
  const para = '第一句内容在这里，写长一点让它单独成块，再多写一些字凑够长度，超过首块的上限吧。' +
    '第二句内容也写长一点让它单独成块，同样再多写一些字凑够长度。'
  assert.equal(splitSpeechText(para).length, 2)
  const speech = speakText(para)
  await tick()
  pauseSpeech()
  first.resolve('end')
  await tick(); await tick()
  assert.equal(state.played.length, 1, 'second chunk must not start while paused')
  resumeSpeech()
  assert.equal(await speech, 'end')
  assert.equal(state.played.length, 2)
})

test('slow first model load shows a loading hint and dismisses it when ready', async () => {
  reset()
  state.synthesize = async text => new Blob([text])
  const load = Promise.withResolvers()
  forgetLocalModel()
  state.warmup = () => load.promise
  const speech = speakText('加载完成后朗读。')
  await new Promise(r => setTimeout(r, LOCAL_LOADING_HINT_MS + 50))
  assert.ok(state.notices.some(n => n[0] === 'tts.localLoading'), 'loading hint shown')
  load.resolve()
  assert.equal(await speech, 'end')
  assert.equal(state.dismissed, 1, 'hint dismissed once the model is loaded')
  // 已加载: 不再提示
  state.notices.length = 0
  assert.equal(await speakText('第二次。'), 'end')
  assert.equal(state.notices.length, 0)
})

test('missing Web Speech API keeps voice lists and playback controls safe', async () => {
  reset()
  const synthesis = globalThis.speechSynthesis
  const utterance = globalThis.SpeechSynthesisUtterance
  try {
    // 有些 WebView 两者都缺失, 也不能把只有 speechSynthesis 的环境视为可朗读。
    delete globalThis.SpeechSynthesisUtterance
    assert.equal(systemSpeechAvailable(), false)
    assert.deepEqual(await getVoices(), [])
    delete globalThis.speechSynthesis
    assert.deepEqual(await listVoicesSorted(), [])
    assert.doesNotThrow(() => { pauseSpeech(); resumeSpeech(); stopSpeech() })
    await assert.rejects(speak('你好。', { rate: 1 }), { message: 'tts.systemUnavailable' })
    state.settings.ttsEngine = 'system'
    await assert.rejects(speakText('你好。'), { message: 'tts.systemUnavailable' })
  } finally {
    globalThis.speechSynthesis = synthesis
    globalThis.SpeechSynthesisUtterance = utterance
  }
  assert.equal(systemSpeechAvailable(), true)
  assert.ok((await listVoicesSorted()).length, 'missing API does not poison the voice cache')
})

test('PDF speech reports unavailable fallback and retries the same text after recovery', async () => {
  reset()
  state.settings.ttsEngine = 'edge'
  const synthesis = globalThis.speechSynthesis
  const utterance = globalThis.SpeechSynthesisUtterance
  const failure = new Error('HTTP 403')
  let calls = 0
  state.synthesize = async text => {
    if (++calls === 1) throw failure
    return new Blob([text])
  }
  delete globalThis.speechSynthesis
  delete globalThis.SpeechSynthesisUtterance
  try {
    // PDF 开始播放会先 stopSpeech, 原来这里就因缺少 Speech API 抛错。
    stopSpeech()
    await assert.rejects(speakText('同一段 PDF 文本。'), e => e === failure)
    assert.deepEqual(state.notices.map(n => n[0]), ['tts.neuralUnavailableNoFallback'])
    assert.equal(state.played.length, 0)
    assert.equal(state.spoken.length, 0)
    // 不重置全局失败标记、不清空缓存, 同一段仍能重新请求在线合成。
    assert.equal(await speakText('同一段 PDF 文本。'), 'end')
    assert.equal(calls, 2)
    assert.equal(await state.played[0].text(), '同一段 PDF 文本。')
  } finally {
    globalThis.speechSynthesis = synthesis
    globalThis.SpeechSynthesisUtterance = utterance
    stopSpeech()
  }
})

test('available system speech still handles online failure for the rest of the session', async () => {
  reset()
  state.settings.ttsEngine = 'edge'
  let calls = 0
  state.synthesize = async () => { calls++; throw new Error('network down') }
  assert.equal(await speakText('第一段。'), 'end')
  assert.equal(await speakText('第二段。'), 'end')
  assert.deepEqual(state.spoken, ['第一段。', '第二段。'])
  assert.deepEqual(state.notices.map(n => n[0]), ['tts.neuralUnavailable'])
  assert.equal(calls, 1, 'working system fallback avoids repeated network failures')
})

test('Android system voices drive PDF playback and direct voice audition without Web Speech', async () => {
  reset()
  state.nativeAvailable = true
  state.settings.ttsEngine = 'system'
  state.settings.ttsVoice = 'zh-local'
  const synthesis = globalThis.speechSynthesis
  const utterance = globalThis.SpeechSynthesisUtterance
  delete globalThis.speechSynthesis
  delete globalThis.SpeechSynthesisUtterance
  try {
    const voices = await listVoicesSorted()
    assert.equal(voices[0].name, 'zh-local')
    assert.equal(voices[0].voiceURI, 'zh-local')
    assert.equal(await speakText('PDF 原生朗读。'), 'end')
    assert.equal(await speak('试听内容。', { voice: voices[0], rate: 1.5 }), 'end')
    assert.deepEqual(state.nativeCalls, [['PDF 原生朗读。', 'zh-local', 1], ['试听内容。', 'zh-local', 1.5]])
    assert.deepEqual(await Promise.all(state.played.map(blob => blob.text())), ['PDF 原生朗读。', '试听内容。'])
    assert.deepEqual(state.spoken, [])
    const gate = Promise.withResolvers()
    state.nativeSynth = () => gate.promise
    const audition = speak('取消试听。', { rate: 1 })
    stopSpeech()
    gate.resolve(new Blob(['取消试听。']))
    assert.equal(await audition, 'cancelled')
    assert.equal(state.played.length, 2)
  } finally {
    globalThis.speechSynthesis = synthesis
    globalThis.SpeechSynthesisUtterance = utterance
    state.settings.ttsVoice = ''
  }
})

test('PDF online failure falls back to native WAV and keeps engine caches separate', async () => {
  reset()
  state.nativeAvailable = true
  state.settings.ttsEngine = 'edge'
  let edgeCalls = 0
  state.synthesize = async () => { edgeCalls++; throw new Error('online unavailable') }
  assert.equal(await speakText('同一段内容。'), 'end')
  assert.equal(await speakText('下一段内容。'), 'end')
  assert.equal(edgeCalls, 1)
  assert.deepEqual(state.nativeCalls.map(args => args[0]), ['同一段内容。', '下一段内容。'])
  assert.deepEqual(await Promise.all(state.played.map(blob => blob.text())), ['同一段内容。', '下一段内容。'])
  assert.deepEqual(state.notices.map(n => n[0]), ['tts.nativeFallback'])
  assert.deepEqual(state.spoken, [])
})

test('native PDF synthesis failure ends once and can be retried', async () => {
  reset()
  state.nativeAvailable = true
  state.settings.ttsEngine = 'system'
  const failure = new Error('native engine failed')
  state.nativeSynth = async () => { throw failure }
  await assert.rejects(speakText('重试内容。'), e => e === failure)
  assert.equal(state.nativeCalls.length, 1, 'native failure must not loop back into itself')
  assert.deepEqual(state.notices.map(n => n[0]), ['tts.nativeFailed'])
  state.nativeSynth = async text => new Blob([text])
  assert.equal(await speakText('重试内容。'), 'end')
  assert.equal(state.nativeCalls.length, 2)
})

test('native fallback requires an installed offline voice and does not claim success without one', async () => {
  reset()
  state.nativeAvailable = true
  state.settings.ttsEngine = 'edge'
  state.nativeVoiceQuery = async () => []
  const failure = new Error('online unavailable')
  state.synthesize = async () => { throw failure }
  await assert.rejects(speakText('没有备用音色。'), e => e === failure)
  assert.deepEqual(state.notices.map(n => n[0]), ['NO_OFFLINE_VOICE'])
  assert.equal(state.nativeCalls.length, 0)
  assert.deepEqual(state.spoken, [])
})

test('stopping while native voice discovery waits cannot redirect a new online session', async () => {
  reset()
  state.nativeAvailable = true
  state.settings.ttsEngine = 'edge'
  const voices = Promise.withResolvers()
  state.nativeVoiceQuery = () => voices.promise
  state.synthesize = async () => { throw new Error('old online failure') }
  const old = speakText('旧会话。')
  await tick()
  stopSpeech()
  resetEdgeFailure()
  state.synthesize = async text => new Blob([text])
  assert.equal(await speakText('新会话。'), 'end')
  voices.resolve(state.nativeVoices)
  assert.equal(await old, 'cancelled')
  assert.equal(await speakText('继续在线。'), 'end')
  assert.equal(state.nativeCalls.length, 0)
  assert.deepEqual(state.notices, [])
})
