/**
 * 汉字读音: 用系统语音 (Web Speech API) 把字读出来, 离线可用。
 *
 * 为什么读「字」而不是读拼音字母: 拼音 "yáo" 交给中文语音会被逐字母念成
 * "y-a-o", 交给英文语音又念错调; 直接读汉字, 系统会按这个字的读音念,
 * 听到的就是卡片上那个拼音。
 */

export type SpeakResult = 'ok' | 'unsupported' | 'no-voice'

/** 设备上有没有语音合成能力 */
export const systemSpeechSupported = () =>
  typeof window !== 'undefined'
  && typeof window.speechSynthesis !== 'undefined'
  && typeof window.SpeechSynthesisUtterance !== 'undefined'

/** 取第一个读音: "háng,xíng" → "háng" */
export function firstReading(pinyin: string): string {
  return (pinyin || '').split(/[,，;；/|]/)[0].trim()
}

let cached: SpeechSynthesisVoice[] = []

/** 部分平台首次 getVoices() 是空的, 等 voiceschanged 一次 */
function loadVoices(timeout = 1200): Promise<SpeechSynthesisVoice[]> {
  if (!systemSpeechSupported()) return Promise.resolve([])
  if (cached.length) return Promise.resolve(cached)
  return new Promise(resolve => {
    const done = () => {
      cached = window.speechSynthesis.getVoices()
      if (cached.length) resolve(cached)
    }
    const now = window.speechSynthesis.getVoices()
    if (now.length) {
      cached = now
      resolve(now)
      return
    }
    const timer = setTimeout(() => resolve(cached), timeout)
    window.speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })
}

function pickChineseVoice(voices: SpeechSynthesisVoice[], preferLang: string) {
  const norm = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-')
  return voices.find(v => norm(v) === preferLang)
    ?? voices.find(v => norm(v).startsWith('zh-CN'))
    ?? voices.find(v => norm(v).startsWith('zh'))
}

/** 正在朗读时便于 UI 显示状态 */
let speakingChar = ''

/**
 * 读一个汉字。返回 ok 表示已经开始朗读; 结果通过 onEnd 回调通知。
 */
export async function speakHanzi(
  char: string,
  opts: { lang?: string; rate?: number; onEnd?: () => void } = {},
): Promise<SpeakResult> {
  if (!systemSpeechSupported()) return 'unsupported'
  const voices = await loadVoices()
  const voice = pickChineseVoice(voices, opts.lang ?? 'zh-CN')
  // 一个中文音色都没有: 读出来也是错的, 直接说不支持
  if (voices.length && !voice) return 'no-voice'

  // 连点两次不叠加, 先停掉上一次
  window.speechSynthesis.cancel()
  const utterance = new window.SpeechSynthesisUtterance(char)
  utterance.lang = voice?.lang ?? opts.lang ?? 'zh-CN'
  if (voice) utterance.voice = voice
  utterance.rate = opts.rate ?? 0.85
  speakingChar = char
  utterance.onend = () => {
    if (speakingChar === char) speakingChar = ''
    opts.onEnd?.()
  }
  utterance.onerror = () => {
    if (speakingChar === char) speakingChar = ''
    opts.onEnd?.()
  }
  window.speechSynthesis.speak(utterance)
  return 'ok'
}

/** 停掉正在进行的朗读 (关卡片 / 换字时调用) */
export function stopSpeaking() {
  if (!systemSpeechSupported()) return
  speakingChar = ''
  window.speechSynthesis.cancel()
}
