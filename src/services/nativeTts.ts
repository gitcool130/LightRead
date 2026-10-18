/** Android TextToSpeech 只合成 WAV, 播放与暂停仍由网页音频管线负责。 */
import { t } from '../i18n'

export interface NativeVoice {
  id: string
  name: string
  lang: string
  local: boolean
  isDefault: boolean
}

interface NativeBridge {
  request(id: string, method: string, payloadJson: string): void
}

declare global {
  interface Window { LightReadNativeTts?: NativeBridge }
}

export class NativeTtsError extends Error {
  code: string
  constructor(code: string, message?: string) {
    const key = code === 'NO_ENGINE' ? 'tts.nativeNoEngine'
      : code === 'NO_OFFLINE_VOICE' ? 'tts.nativeNoVoice'
        : code === 'TIMEOUT' ? 'tts.nativeTimeout' : 'tts.nativeFailed'
    super(code === 'CANCELLED' ? 'Speech cancelled' : t(key))
    this.name = 'NativeTtsError'
    this.code = code
    if (message) this.cause = message
  }
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let seq = 0
let listeningWindow: Window | null = null
export const nativeTtsAvailable = () => typeof window !== 'undefined'
  && typeof window.LightReadNativeTts?.request === 'function'

function settle(id: string, ok: boolean, value: unknown) {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  if (ok) entry.resolve(value)
  else entry.reject(value)
}

function onResult(event: Event) {
  const result = (event as CustomEvent).detail
  if (!result || typeof result.id !== 'string') return
  settle(result.id, result.ok === true, result.ok === true ? result.result
    : new NativeTtsError(result.error?.code ?? 'FAILED', result.error?.message))
}

function request<T>(method: string, payload: object): Promise<T> {
  if (!nativeTtsAvailable()) return Promise.reject(new NativeTtsError('NO_ENGINE'))
  if (listeningWindow !== window) {
    listeningWindow?.removeEventListener('lightread-native-tts', onResult)
    window.addEventListener('lightread-native-tts', onResult)
    listeningWindow = window
  }
  const id = `tts-${Date.now().toString(36)}-${++seq}`
  // voices 也会排在正在执行的原生合成之后。
  const timeout = method === 'cancel' ? 5_000 : 60_000
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(id, false, new NativeTtsError('TIMEOUT'))
      if (method === 'synthesize') void request('cancel', { requestId: id }).catch(() => {})
    }, timeout)
    pending.set(id, { method, resolve: value => resolve(value as T), reject, timer })
    try { window.LightReadNativeTts!.request(id, method, JSON.stringify(payload)) }
    catch (e) { settle(id, false, new NativeTtsError('FAILED', String(e))) }
  })
}

/** 不缓存失败或空列表, 安装引擎 / 下载语音数据后可立即重试。 */
export async function listNativeVoices(): Promise<NativeVoice[]> {
  const result = await request<{ voices: NativeVoice[]; defaultVoiceId?: string | null }>('voices', {})
  if (!Array.isArray(result?.voices)) throw new NativeTtsError('FAILED')
  return result.voices.filter(v => v && typeof v.id === 'string' && typeof v.lang === 'string')
    .map(v => ({ ...v, name: v.name || v.id, isDefault: v.isDefault || v.id === result.defaultVoiceId }))
}

export async function nativeTtsSynthesize(text: string, voiceId = '', rate = 1): Promise<Blob> {
  const result = await request<{ audioBase64: string; mimeType: string }>('synthesize', {
    text, voiceId: voiceId || undefined, rate,
  })
  try {
    if (result?.mimeType !== 'audio/wav' || !result.audioBase64) throw new Error('Missing WAV')
    const raw = atob(result.audioBase64)
    if (raw.length < 44 || raw.slice(0, 4) !== 'RIFF' || raw.slice(8, 12) !== 'WAVE') throw new Error('Invalid WAV')
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0))
    return new Blob([bytes], { type: 'audio/wav' })
  } catch (e) { throw new NativeTtsError('FAILED', String(e)) }
}

/** 捕获此刻的合成请求逐个取消, 迟到的停止命令不会取消随后新建的会话。 */
export function nativeTtsStop(): void {
  for (const [id, entry] of [...pending]) {
    if (entry.method !== 'synthesize') continue
    settle(id, false, new NativeTtsError('CANCELLED'))
    void request('cancel', { requestId: id }).catch(() => {})
  }
}
