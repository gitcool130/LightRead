<script setup lang="ts">
/**
 * 查字浮卡: 汉字 + 拼音 + 释义, 每个字可以点喇叭听读音。
 * PDF 与 EPUB 两个阅读器共用, 位置由调用方按选区算好传进来 (视口坐标)。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import type { HanziEntry } from '../services/hanzi'
import { speakHanzi, stopSpeaking, systemSpeechSupported } from '../services/hanziSpeech'
import { toast } from '../services/toast'

const props = defineProps<{
  entries: HanziEntry[]
  /** 视口坐标, 已由调用方夹到窗口内 */
  x: number
  y: number
}>()

const emit = defineEmits<{
  close: []
}>()

/** 正在朗读的字, 用来给按钮加动效 */
const speaking = ref('')
const canSpeak = systemSpeechSupported()

async function speak(entry: HanziEntry) {
  if (!canSpeak) {
    toast(t('reader.lookupSpeakFail'), 'error', 2600)
    return
  }
  if (speaking.value === entry.char) {
    stopSpeaking()
    speaking.value = ''
    return
  }
  const result = await speakHanzi(entry.char, {
    onEnd: () => {
      if (speaking.value === entry.char) speaking.value = ''
    },
  })
  if (result === 'ok') {
    speaking.value = entry.char
    return
  }
  speaking.value = ''
  toast(t(result === 'no-voice' ? 'reader.lookupNoVoice' : 'reader.lookupSpeakFail'), 'error', 2600)
}

// 换了字 / 关闭卡片都要停掉，别让上一个字念到一半还在响
watch(() => props.entries, () => {
  stopSpeaking()
  speaking.value = ''
})
onBeforeUnmount(() => {
  stopSpeaking()
})

function close() {
  stopSpeaking()
  emit('close')
}
</script>

<template>
  <div
    class="hanzi-card card"
    :style="{ left: `${x}px`, top: `${y}px` }"
    role="dialog"
    :aria-label="t('reader.lookupTitle')"
  >
    <div class="hanzi-head">
      <strong>{{ t('reader.lookupTitle') }}</strong>
      <span class="hanzi-count">{{ entries.length }}{{ t('reader.lookupChars') }}</span>
      <span style="flex: 1" />
      <button
        type="button"
        class="icon-btn"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="close"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </div>
    <div class="hanzi-list">
      <div v-for="e in entries" :key="e.char" class="hanzi-item">
        <div class="hanzi-char-row">
          <span class="hanzi-char">{{ e.char }}</span>
          <span class="hanzi-pinyin">{{ e.pinyin || t('reader.lookupNoEntry') }}</span>
          <button
            type="button"
            class="hanzi-speak"
            :class="{ speaking: speaking === e.char }"
            :title="t('reader.lookupSpeak')"
            :aria-label="`${t('reader.lookupSpeak')}：${e.char}`"
            :aria-pressed="speaking === e.char"
            @click="speak(e)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" />
              <path d="M15.5 9a4 4 0 0 1 0 6" />
              <path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
            </svg>
          </button>
        </div>
        <p class="hanzi-def">{{ e.def || t('reader.lookupNoEntry') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hanzi-card {
  position: fixed;
  z-index: 72;
  width: min(300px, calc(100vw - 24px));
  max-height: min(60vh, 420px);
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
}
.hanzi-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.hanzi-count {
  font-size: 12px;
  color: var(--text-3);
}
.hanzi-list {
  overflow: auto;
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hanzi-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hanzi-char-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.hanzi-char {
  font-size: 24px;
  line-height: 1.1;
  color: var(--text);
  font-family: var(--font-serif, serif);
}
.hanzi-pinyin {
  font-size: 13px;
  color: var(--brand);
  letter-spacing: 0.02em;
}
.hanzi-speak {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.hanzi-speak svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hanzi-speak:hover {
  background: var(--surface-2);
  color: var(--brand);
}
.hanzi-speak.speaking {
  color: var(--brand);
  animation: hanzi-speak-pulse 1s ease-in-out infinite;
}
@keyframes hanzi-speak-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@media (prefers-reduced-motion: reduce) {
  .hanzi-speak.speaking { animation: none; }
}
.hanzi-def {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
