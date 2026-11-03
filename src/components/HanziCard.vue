<script setup lang="ts">
/**
 * 查字浮卡: 汉字 + 拼音 + 释义。
 * PDF 与 EPUB 两个阅读器共用, 位置由调用方按选区算好传进来 (视口坐标)。
 */
import { t } from '../i18n'
import type { HanziEntry } from '../services/hanzi'

defineProps<{
  entries: HanziEntry[]
  /** 视口坐标, 已由调用方夹到窗口内 */
  x: number
  y: number
}>()

defineEmits<{
  close: []
}>()
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
        @click="$emit('close')"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 6.3a1 1 0 0 1 1.4 0L12 10.58l4.3-4.3a1 1 0 1 1 1.4 1.42L13.42 12l4.3 4.3a1 1 0 0 1-1.42 1.4L12 13.42l-4.3 4.3a1 1 0 0 1-1.4-1.42L10.58 12l-4.3-4.3a1 1 0 0 1 0-1.4z"/></svg>
      </button>
    </div>
    <div class="hanzi-list">
      <div v-for="e in entries" :key="e.char" class="hanzi-item">
        <div class="hanzi-char-row">
          <span class="hanzi-char">{{ e.char }}</span>
          <span class="hanzi-pinyin">{{ e.pinyin || t('reader.lookupNoEntry') }}</span>
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
.hanzi-def {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
