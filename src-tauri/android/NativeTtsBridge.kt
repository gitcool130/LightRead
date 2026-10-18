package com.yzfly.lightread

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Android 系统语音只负责合成，暂停/恢复/进度继续由网页音频播放器管理。
 * request(id, voices|synthesize|cancel, payloadJson) 的结果通过 lightread-native-tts 返回。
 * 不接收文件路径；仅使用已安装的离线音色，不隐式改用联网合成。
 * 引擎状态、请求和回调都在主线程串行处理；WAV 读取和编码在独立线程完成。
 */
class NativeTtsBridge(context: Context, private val webView: WebView) {
  private val appContext = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val files = Executors.newSingleThreadExecutor()
  private val audioDir = File(appContext.cacheDir, "native-tts")
  private val pending = LinkedHashMap<String, Request>()
  private val queue = ArrayDeque<String>()
  private var engine: TextToSpeech? = null
  private var ready = false
  private var initializing = false
  private var destroyed = false
  private var initGeneration = 0
  private var initTimeout: Runnable? = null
  private var active: Request? = null

  private class Request(val id: String, val method: String, val payload: JSONObject) {
    val deadline = SystemClock.uptimeMillis() + 45_000L
    var timeout: Runnable? = null
    var file: File? = null
    var utteranceId: String? = null
    var readingAudio = false
  }

  init {
    // 仅清理本类留下的旧缓存，避免读取上一次进程意外退出留下的文件。
    val before = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
    files.execute {
      audioDir.listFiles()?.filter {
        it.name.startsWith("speech-") && it.name.endsWith(".wav") && it.lastModified() < before
      }?.forEach { it.delete() }
    }
  }

  @JavascriptInterface
  fun request(id: String, method: String, payloadJson: String) {
    main.post {
      if (destroyed) return@post
      if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(id) || payloadJson.length > 65_536) {
        replyError(id.take(128), "INVALID_REQUEST", "Invalid native speech request")
        return@post
      }
      val payload = try { JSONObject(payloadJson) } catch (_: Exception) {
        replyError(id, "INVALID_REQUEST", "Invalid native speech request")
        return@post
      }
      if (method == "cancel") {
        val target = payload.optString("requestId", "")
        pending.values.filter {
          it.method == "synthesize" && (target.isEmpty() || it.id == target)
        }.toList().forEach { finishError(it, "CANCELLED", "Speech synthesis cancelled") }
        reply(id, true, JSONObject.NULL)
        return@post
      }
      if (method != "voices" && method != "synthesize") {
        replyError(id, "INVALID_REQUEST", "Unknown native speech method")
        return@post
      }
      if (pending.containsKey(id)) return@post
      if (pending.size >= 16) {
        replyError(id, "BUSY", "Too many native speech requests")
        return@post
      }
      if (method == "synthesize") {
        val text = payload.optString("text", "")
        if (text.isBlank()) {
          replyError(id, "INVALID_REQUEST", "Speech text is empty")
          return@post
        }
        if (text.length > TextToSpeech.getMaxSpeechInputLength()) {
          replyError(id, "TEXT_TOO_LONG", "Speech text exceeds the system limit")
          return@post
        }
        val rate = payload.optDouble("rate", 1.0)
        if (!rate.isFinite() || rate < 0.1 || rate > 4.0) {
          replyError(id, "INVALID_REQUEST", "Invalid speech rate")
          return@post
        }
      }
      val request = Request(id, method, payload)
      pending[id] = request
      queue.addLast(id)
      armTimeout(request, 45_000L)
      ensureEngine()
      pump()
    }
  }

  private fun ensureEngine() {
    if (ready || initializing || destroyed) return
    initializing = true
    val generation = ++initGeneration
    val timeout = Runnable {
      if (generation == initGeneration && initializing) failInit("System speech initialization timed out")
    }
    initTimeout = timeout
    main.postDelayed(timeout, 15_000L)
    try {
      engine = TextToSpeech(appContext) { status ->
        main.post {
          if (destroyed || generation != initGeneration) return@post
          if (status != TextToSpeech.SUCCESS) {
            failInit("No working system speech engine is installed")
          } else {
            initTimeout?.let { main.removeCallbacks(it) }
            initTimeout = null
            initializing = false
            ready = true
            engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
              override fun onStart(utteranceId: String?) {}
              override fun onDone(utteranceId: String?) { main.post { readAudio(utteranceId) } }
              @Deprecated("Android compatibility callback")
              override fun onError(utteranceId: String?) { synthesisError(utteranceId) }
              override fun onError(utteranceId: String?, errorCode: Int) { synthesisError(utteranceId) }
              override fun onStop(utteranceId: String?, interrupted: Boolean) {
                main.post {
                  active?.takeIf { it.utteranceId == utteranceId }?.let {
                    finishError(it, "CANCELLED", "Speech synthesis cancelled")
                  }
                }
              }
            })
            pump()
          }
        }
      }
    } catch (_: Exception) {
      failInit("No working system speech engine is installed")
    }
  }

  private fun failInit(message: String) {
    ++initGeneration
    initTimeout?.let { main.removeCallbacks(it) }
    initTimeout = null
    ready = false
    initializing = false
    try { engine?.shutdown() } catch (_: Exception) {}
    engine = null
    pending.values.toList().forEach { finishError(it, "NO_ENGINE", message) }
  }

  private fun local(voice: Voice): Boolean = !voice.isNetworkConnectionRequired &&
    voice.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true

  private fun chinese(voice: Voice): Boolean = voice.locale.language in setOf("zh", "cmn", "yue")

  // 部分系统引擎会让不同语言变体共用 name，例如 zh-Hans / zh-Hant 都叫 zh。
  private fun voiceId(voice: Voice): String = "${voice.name} [${voice.locale.toLanguageTag()}]"

  private fun voices(tts: TextToSpeech): List<Voice> {
    val defaultId = tts.defaultVoice?.let { voiceId(it) }
    return tts.voices.orEmpty().sortedWith(
      compareByDescending<Voice> { local(it) && chinese(it) }
        .thenByDescending { local(it) }
        .thenByDescending { voiceId(it) == defaultId }
        .thenBy { voiceId(it) }
    )
  }

  private fun selectVoice(voices: List<Voice>, selected: String, text: String): Voice? {
    val available = voices.filter { local(it) }
    val needsChinese = text.any { it in '\u3400'..'\u9fff' || it in '\uf900'..'\ufaff' }
    val automatic = available.firstOrNull { !needsChinese || chinese(it) }
    if (selected.isEmpty()) return automatic
    available.firstOrNull { voiceId(it) == selected }?.let { return it }
    // 兼容旧版保存的纯 name：唯一时沿用；有歧义时按文本语言及系统默认顺序选择。
    val legacy = available.filter { it.name == selected }
    return if (legacy.size == 1) legacy.single() else if (legacy.isNotEmpty()) automatic else null
  }

  private fun pump() {
    if (destroyed || !ready || active != null) return
    val tts = engine ?: return
    while (queue.isNotEmpty()) {
      val request = pending[queue.removeFirst()] ?: continue
      try {
        val voices = voices(tts)
        if (request.method == "voices") {
          val entries = JSONArray()
          val defaultId = tts.defaultVoice?.let { voiceId(it) }
          voices.forEach { voice ->
            entries.put(JSONObject().put("id", voiceId(voice)).put("name", voice.name)
              .put("lang", voice.locale.toLanguageTag()).put("local", local(voice))
              .put("isDefault", voiceId(voice) == defaultId))
          }
          finish(request, JSONObject().put("voices", entries)
            .put("defaultVoiceId", voices.firstOrNull { local(it) }?.let { voiceId(it) } ?: JSONObject.NULL))
          continue
        }
        val text = request.payload.optString("text")
        val selected = request.payload.optString("voiceId", "")
        val voice = selectVoice(voices, selected, text)
        if (voice == null) {
          finishError(request, "NO_OFFLINE_VOICE", "No installed offline voice supports this text")
          continue
        }
        if (tts.setVoice(voice) != TextToSpeech.SUCCESS ||
          tts.setSpeechRate(request.payload.optDouble("rate", 1.0).toFloat()) != TextToSpeech.SUCCESS) {
          finishError(request, "NO_OFFLINE_VOICE", "The selected offline voice is unavailable")
          continue
        }
        if (!audioDir.isDirectory && !audioDir.mkdirs()) throw IllegalStateException("Cannot create speech cache")
        val file = File.createTempFile("speech-", ".wav", audioDir)
        request.file = file
        request.utteranceId = UUID.randomUUID().toString()
        active = request
        armTimeout(request, minOf(30_000L, request.deadline - SystemClock.uptimeMillis()).coerceAtLeast(1L))
        @Suppress("DEPRECATION") // 同时兼容仍识别此参数的旧引擎；上面已用 Voice 强制选离线音色。
        val params = Bundle().apply { putString(TextToSpeech.Engine.KEY_FEATURE_EMBEDDED_SYNTHESIS, "true") }
        if (tts.synthesizeToFile(text, params, file, request.utteranceId!!) != TextToSpeech.SUCCESS) {
          finishError(request, "SYNTHESIS_FAILED", "System speech synthesis failed")
        }
        return
      } catch (_: Exception) {
        finishError(request, "SYNTHESIS_FAILED", "System speech synthesis failed")
      }
    }
  }

  private fun synthesisError(utteranceId: String?) {
    main.post {
      active?.takeIf { it.utteranceId == utteranceId }?.let {
        finishError(it, "SYNTHESIS_FAILED", "System speech synthesis failed")
      }
    }
  }

  private fun readAudio(utteranceId: String?) {
    val request = active?.takeIf { it.utteranceId == utteranceId && !it.readingAudio } ?: return
    val file = request.file ?: return
    request.readingAudio = true
    files.execute {
      val result = try {
        require(file.length() in 45L..8_388_608L)
        val bytes = file.readBytes()
        require(bytes.size > 44 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
          String(bytes, 8, 4, Charsets.US_ASCII) == "WAVE")
        JSONObject().put("audioBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("mimeType", "audio/wav")
      } catch (_: Exception) { null } finally { file.delete() }
      main.post {
        if (pending[request.id] !== request || destroyed) return@post
        if (result != null) finish(request, result)
        else finishError(request, "INVALID_AUDIO", "System speech returned no usable WAV audio")
      }
    }
  }

  private fun armTimeout(request: Request, millis: Long) {
    request.timeout?.let { main.removeCallbacks(it) }
    val timeout = Runnable { finishError(request, "TIMEOUT", "System speech synthesis timed out") }
    request.timeout = timeout
    main.postDelayed(timeout, millis)
  }

  private fun finish(request: Request, result: Any) {
    if (pending.remove(request.id) !== request) return
    request.timeout?.let { main.removeCallbacks(it) }
    queue.remove(request.id)
    if (active === request) active = null
    request.file?.delete()
    reply(request.id, true, result)
    main.post { pump() }
  }

  private fun finishError(request: Request, code: String, message: String) {
    if (pending[request.id] !== request) return
    // 只有当前请求才可 stop；取消旧的排队任务不能中断其他会话的新请求。
    if (active === request) {
      active = null
      try { engine?.stop() } catch (_: Exception) {}
    }
    pending.remove(request.id)
    request.timeout?.let { main.removeCallbacks(it) }
    queue.remove(request.id)
    request.file?.delete()
    replyError(request.id, code, message)
    main.post { pump() }
  }

  private fun replyError(id: String, code: String, message: String) {
    reply(id, false, JSONObject().put("code", code).put("message", message))
  }

  private fun reply(id: String, ok: Boolean, value: Any) {
    if (destroyed) return
    val payload = JSONObject().put("id", id).put("ok", ok).put(if (ok) "result" else "error", value)
    // JSON 再作为字符串编码，音色名/错误详情都不能注入可执行 JS。
    val encoded = JSONObject.quote(payload.toString())
    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('lightread-native-tts',{detail:JSON.parse($encoded)}))", null)
  }

  fun shutdown() {
    destroyed = true
    ++initGeneration
    initTimeout?.let { main.removeCallbacks(it) }
    pending.values.forEach { request ->
      request.timeout?.let { main.removeCallbacks(it) }
      request.file?.delete()
    }
    pending.clear()
    queue.clear()
    active = null
    try { engine?.stop(); engine?.shutdown() } catch (_: Exception) {}
    engine = null
    files.shutdown()
  }
}
