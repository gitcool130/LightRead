<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { BookMeta } from '../storage'
import { formatLabelOf } from '../services/plainText'
import { formatReadingTime } from '../composables/useReadingTimer'
import { shortAuthor, shortTitle } from '../services/displayTitle'
import { t } from '../i18n'

const props = defineProps<{
  book: BookMeta
  coverUrl?: string
  /** 管理模式: 点击变为选择 */
  selectable?: boolean
  selected?: boolean
  showBooklists?: boolean
  /** 可转换为 EPUB (MOBI / AZW3 / FB2 / TXT 等) */
  convertible?: boolean
  /** 正在转换: 按钮禁用 */
  converting?: boolean
  /** 显示「发送到其他设备」(设置里开启了互传) */
  sendable?: boolean
  /** 手机书格: 封面只留进度条, 操作收进作者行的「⋯」(由父组件弹出操作面板) */
  compact?: boolean
}>()

/** 解码失败的封面地址: 改显示文字封面, 换了新地址 (修复后) 再试 */
const brokenCover = ref<string>()

/** 封面占位标题的断行点: 文件名式标题 (package.json / my_notes-v2) 在 . _ - / 之后换行, 不在词中间硬断 */
const coverTitleParts = computed(() => props.book.title.replace(/([._\-/])/g, '$1\u0000').split('\u0000'))

const emit = defineEmits<{
  open: []
  remove: []
  toggleSelect: []
  togglePin: []
  addToBooklist: []
  upload: []
  convert: []
  /** 发送到其他设备 (互传) */
  send: []
  /** compact: 点「⋯」 */
  menu: []
  /** compact: 长按封面 */
  longPress: []
}>()

const progress = computed(() => {
  const p = props.book.progress
  if (p == null) return null
  return Math.min(100, Math.max(0, Math.round(p * 100)))
})

const tooltip = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (props.book.noSync) parts.push(t('library.privateBadge'))
  if (props.book.readingSeconds && props.book.readingSeconds >= 60) {
    parts.push(t('book.readTime', { time: formatReadingTime(props.book.readingSeconds) }))
  }
  return parts.join('\n')
})

const ariaLabel = computed(() => {
  const parts = [props.book.title]
  if (props.book.author) parts.push(props.book.author)
  if (progress.value != null) parts.push(`${progress.value}%`)
  if (props.book.noSync) parts.push(t('library.privateBadge'))
  return parts.join(', ')
})

// 无封面时由书名稳定地取一组纸色 + 墨色令牌 (与 App 的生成封面一致)
const titleHash = computed(() => {
  let hash = 0
  for (const ch of props.book.title) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(hash)
})
const fallbackTone = computed(() => titleHash.value % 6)

/* compact 的书名 / 元信息: 短书名; 「12% · 作者」, 读完显示「读完」, 未读不显示进度 */
const displayTitle = computed(() => (props.compact ? shortTitle(props.book.title) : props.book.title))
const metaProgress = computed(() => {
  const p = progress.value
  if (p == null || p <= 0) return ''
  return p >= 99 ? t('library.finished') : `${p}%`
})
const metaAuthor = computed(() => shortAuthor(props.book.author) || t('common.anonymous'))

function activate() {
  if (props.selectable) emit('toggleSelect')
  else emit('open')
}

/* 触屏设备: 封面操作收进「更多」按钮, 点一下展开, 点别处收起 */
const menuOpen = ref(false)
const actionsEl = ref<HTMLElement | null>(null)
function closeMenu() {
  menuOpen.value = false
  document.removeEventListener('pointerdown', onOutsidePointerDown, true)
}
function onOutsidePointerDown(e: PointerEvent) {
  // 按下点在菜单内部时不能收起: 收起会让按钮瞬间 pointer-events:none,
  // 随后的 click 命中测试会落到卡片上, 变成打开书籍 (触屏专属问题)
  if (actionsEl.value && e.target instanceof Node && actionsEl.value.contains(e.target)) return
  closeMenu()
}
function toggleMenu() {
  if (menuOpen.value) return closeMenu()
  openMenu()
}
function openMenu() {
  if (menuOpen.value) return
  menuOpen.value = true
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePointerDown, true))
}
function menuAction(event: 'remove' | 'togglePin' | 'addToBooklist' | 'upload' | 'convert' | 'send') {
  closeMenu()
  if (event === 'remove') emit('remove')
  else if (event === 'send') emit('send')
  else if (event === 'togglePin') emit('togglePin')
  else if (event === 'upload') emit('upload')
  else if (event === 'convert') emit('convert')
  else emit('addToBooklist')
}
/* 触屏长按封面: 与点「更多」一样展开操作 (系统的长按菜单无意义, 拦掉) */
function onContextMenu(e: Event) {
  if (props.compact) {
    // 手机书格: 长按进入选择并选中这本 (选择模式下由点击切换)
    e.preventDefault()
    if (!props.selectable) emit('longPress')
    return
  }
  if (props.selectable || !window.matchMedia('(hover: none)').matches) return
  e.preventDefault()
  openMenu()
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePointerDown, true))

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activate()
  }
}
</script>

<template>
  <div
    class="book-card"
    :class="{ selected: selectable && selected, selectable, compact, 'menu-open': menuOpen }"
    :title="tooltip"
    :role="selectable ? 'checkbox' : 'button'"
    :aria-checked="selectable ? selected : undefined"
    :aria-label="ariaLabel"
    tabindex="0"
    @click="activate"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  >
    <div class="cover">
      <span v-if="selectable" class="select-mark" :class="{ on: selected }" aria-hidden="true">
        <svg v-if="selected" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9.55 15.51 5.7 11.66a1 1 0 0 0-1.4 1.42l4.54 4.54a1 1 0 0 0 1.42 0l9.44-9.44a1 1 0 1 0-1.42-1.42l-8.73 8.75z"/></svg>
      </span>
      <img v-if="coverUrl && coverUrl !== brokenCover" :src="coverUrl" alt="" loading="lazy" decoding="async" @error="brokenCover = coverUrl" />
      <div
        v-else
        class="cover-fallback"
        :class="`tone-${fallbackTone}`"
        aria-hidden="true"
      >
        <span class="cover-fallback-title"><template v-if="compact">{{ displayTitle }}</template><template v-else v-for="(part, i) in coverTitleParts" :key="i">{{ part }}<wbr /></template></span>
        <span v-if="book.author" class="cover-fallback-author">{{ compact ? metaAuthor : book.author }}</span>
      </div>
      <span class="format" aria-hidden="true">{{ formatLabelOf(book) }}<svg v-if="book.noSync" class="private-mark" viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z"/></svg></span>
      <span v-if="progress != null" class="progress" aria-hidden="true">{{ progress }}%</span>
      <span v-if="progress != null" class="progress-track" aria-hidden="true">
        <span class="progress-fill" :style="{ width: `${progress}%` }" />
      </span>

      <span v-if="compact && book.noSync" class="compact-private" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z"/></svg>
      </span>

      <div v-if="!selectable && !compact" ref="actionsEl" class="actions" :class="{ open: menuOpen }">
        <button
          type="button"
          class="action more hit"
          :title="t('common.moreActions')"
          :aria-label="t('common.moreActions')"
          :aria-expanded="menuOpen"
          @click.stop="toggleMenu"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>
        </button>
        <button
          type="button"
          class="action pin"
          :class="{ pinned: !!book.pinnedAt }"
          :title="book.pinnedAt ? t('library.unpin') : t('library.pin')"
          :aria-label="book.pinnedAt ? t('library.unpin') : t('library.pin')"
          :aria-pressed="!!book.pinnedAt"
          @click.stop="menuAction('togglePin')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.6 2.6a2 2 0 0 1 2.83 0l4 4a2 2 0 0 1 0 2.82l-3.18 3.18.35 2.47a2 2 0 0 1-.56 1.7l-1.1 1.1a1 1 0 0 1-1.42 0L11.6 13.9l-5.9 5.9a1 1 0 0 1-1.4-1.42l5.88-5.89-3.95-3.95a1 1 0 0 1 0-1.41l1.1-1.1a2 2 0 0 1 1.7-.57l2.47.35 3.1-3.2z"/></svg>
        </button>
        <button
          v-if="showBooklists"
          type="button"
          class="action booklist-action"
          :title="t('library.addToBooklist')"
          :aria-label="t('library.addToBooklist')"
          @click.stop="menuAction('addToBooklist')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 4a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v6a1 1 0 1 1-2 0V5a1 1 0 0 0-1-1H7v14.38l4.55-2.28a1 1 0 0 1 .9 0l1.1.55a1 1 0 1 1-.9 1.79L12 18.12 6.45 20.9A1 1 0 0 1 5 20V4zm14 10a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 1 1 0-2h2v-2a1 1 0 0 1 1-1z"/></svg>
        </button>
        <button
          v-if="convertible"
          type="button"
          class="action convert"
          :title="t('book.convertToEpub')"
          :aria-label="t('book.convertToEpub')"
          :disabled="converting"
          @click.stop="menuAction('convert')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5"/></svg>
        </button>
        <button
          type="button"
          class="action upload"
          :title="t('library.uploadToCloud')"
          :aria-label="t('library.uploadToCloud')"
          @click.stop="menuAction('upload')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 18H5a4 4 0 0 1-.6-8 7 7 0 0 1 13.4-2 5 5 0 0 1 1.2 10h-2M12 20V10m-4 4 4-4 4 4"/></svg>
        </button>
        <button
          v-if="sendable"
          type="button"
          class="action send"
          :title="t('transfer.sendToDevices')"
          :aria-label="t('transfer.sendToDevices')"
          @click.stop="menuAction('send')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/></svg>
        </button>
        <button
          type="button"
          class="action remove"
          :title="t('book.removeFromLibrary')"
          :aria-label="t('book.removeFromLibrary')"
          @click.stop="menuAction('remove')"
          @keydown.stop
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 6a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9zm4 0a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9z"/></svg>
        </button>
      </div>
    </div>
    <div class="title">
      <svg v-if="compact && book.pinnedAt" class="pinned-mark" viewBox="0 0 24 24" width="12" height="12" :aria-label="t('library.pin')"><path fill="currentColor" d="M14.6 2.6a2 2 0 0 1 2.83 0l4 4a2 2 0 0 1 0 2.82l-3.18 3.18.35 2.47a2 2 0 0 1-.56 1.7l-1.1 1.1a1 1 0 0 1-1.42 0L11.6 13.9l-5.9 5.9a1 1 0 0 1-1.4-1.42l5.88-5.89-3.95-3.95a1 1 0 0 1 0-1.41l1.1-1.1a2 2 0 0 1 1.7-.57l2.47.35 3.1-3.2z"/></svg>{{ displayTitle }}
    </div>
    <div v-if="compact" class="meta">
      <span class="meta-text"><template v-if="metaProgress"><span :class="{ 'meta-done': progress != null && progress >= 99 }">{{ metaProgress }}</span> · </template>{{ metaAuthor }}</span>
      <button
        v-if="!selectable"
        type="button"
        class="meta-more"
        :title="t('common.moreActions')"
        :aria-label="t('common.moreActions')"
        @click.stop="emit('menu')"
        @keydown.stop
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>
      </button>
    </div>
    <div v-else class="author">{{ book.author || t('common.anonymous') }}</div>
  </div>
</template>

<style scoped>
.book-card {
  cursor: pointer;
  border-radius: var(--radius);
  outline: none;
  transition: transform var(--dur) var(--ease);
}
.book-card:hover {
  transform: translateY(-2px);
}
.book-card:hover .cover {
  box-shadow: var(--shadow-md);
}
.book-card:focus-visible .cover {
  box-shadow: var(--ring), var(--shadow-md);
}
.book-card.selected .cover {
  outline: 3px solid var(--brand);
  outline-offset: -1px;
}
.cover {
  position: relative;
  aspect-ratio: 3 / 4.2;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background: var(--surface-2);
  transition: box-shadow var(--dur) var(--ease);
}
.cover::after {
  /* 书页内阴影, 让纯色封面有一点厚度 */
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.06),
    inset 3px 0 6px -3px rgba(0, 0, 0, 0.18);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 0;
  padding: 26% 13% 12%;
  text-align: left;
  /* 生成封面: 纸色 + 衬线书名 + 细线 (与 App 一致), 不用渐变色块 */
  color: var(--ink);
  background: var(--paper);
  border-left: 3px solid color-mix(in srgb, var(--ink) 12%, transparent);
}
.cover-fallback::before {
  content: '';
  height: 1px;
  margin-bottom: 14%;
  background: currentColor;
  opacity: 0.35;
}
.cover-fallback-title {
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  font-size: 16px;
  overflow-wrap: break-word;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.03em;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cover-fallback-author {
  margin-top: auto;
  font-size: 11px;
  opacity: 0.7;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.select-mark {
  position: absolute;
  left: 6px;
  bottom: 6px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: rgba(29, 33, 41, 0.35);
  box-shadow: 0 0 0 1px rgba(29, 33, 41, 0.2);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.select-mark.on {
  background: var(--brand);
}
.private-mark {
  margin-left: 4px;
  vertical-align: -1px;
}
.format {
  position: absolute;
  left: 6px;
  top: 6px;
  background: rgba(17, 20, 26, 0.6);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
}
.progress {
  position: absolute;
  right: 6px;
  bottom: 8px;
  background: rgba(17, 20, 26, 0.6);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
}
.progress-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(17, 20, 26, 0.25);
}
.progress-fill {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width var(--dur-slow) var(--ease);
}

/* 封面上的操作: 桌面悬停 / 键盘聚焦时显示; 触屏设备常显; 已置顶徽标常显 */
.actions {
  position: absolute;
  right: 6px;
  top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.action {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: rgba(17, 20, 26, 0.6);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateY(-2px);
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.action.pinned {
  opacity: 1;
  transform: none;
}
.action:hover {
  background: rgba(17, 20, 26, 0.85);
}
.action:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
.pin.pinned,
.pin:hover,
.booklist-action:hover,
.convert:hover,
.send:hover {
  background: var(--brand);
}
.action:disabled {
  cursor: progress;
  background: rgba(17, 20, 26, 0.35);
}
.remove:hover {
  background: var(--danger);
}
/* 「更多」按钮仅触屏设备可见 */
.action.more {
  display: none;
}
/* 有悬停能力的设备: 悬停 / 键盘聚焦时展开全部操作 */
@media (hover: hover) {
  .book-card:hover .action,
  .book-card:focus-within .action {
    opacity: 1;
    transform: none;
  }
}
/* 触屏设备: 点「更多」展开 */
@media (hover: none) {
  .book-card {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .action {
    width: 32px;
    height: 32px;
  }
  /* 小封面放不下一整列按钮: 展开时每列最多 4 个, 向左折成多列 (「更多」仍在右上角) */
  .actions.open {
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(4, auto);
    direction: rtl;
    justify-items: start;
    align-content: start;
  }
  /* 「更多」常驻但不抢封面: 小圆点按钮, 热区靠透明外扩补足 */
  .action.more {
    display: flex;
    opacity: 1;
    transform: none;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    position: relative;
    background: rgba(17, 20, 26, 0.38);
  }
  .action.more::before {
    content: '';
    position: absolute;
    inset: -8px;
  }
  .actions.open .action {
    opacity: 1;
    transform: none;
  }
  /* 展开的操作折成两列时会压住左上角的格式标签: 先隐去 */
  .book-card.menu-open .format {
    opacity: 0;
  }
  .actions.open .action.more {
    background: var(--brand);
  }
  .actions:not(.open) .action:not(.more):not(.pinned) {
    pointer-events: none;
  }
}

.title {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.author {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 手机书格 (compact): 封面像书, 只留进度条; 书名 + 「进度 · 作者 ⋯」 ---- */
.compact,
.compact:hover {
  transform: none;
}
.compact .cover {
  aspect-ratio: 2 / 3;
  border-radius: 3px 5px 5px 3px;
  box-shadow: var(--cover-shadow);
}
.compact:hover .cover {
  box-shadow: var(--cover-shadow);
}
.compact:active:not(.selectable) .cover {
  transform: scale(0.97);
  transition: transform var(--dur-fast) var(--ease);
}
/* 书脊高光 + 细描边: 白封面也有边界 */
.compact .cover::after {
  box-shadow: inset 0 0 0 1px var(--cover-edge);
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.12) 0, rgba(255, 255, 255, 0.14) 2.5%, transparent 6%);
}
.compact .format,
.compact .progress {
  display: none;
}
.compact .progress-track {
  background: rgba(255, 255, 255, 0.55);
}
:root[data-theme='dark'] .compact .progress-track {
  background: rgba(0, 0, 0, 0.45);
}
.compact.selected .cover {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.compact .select-mark {
  left: auto;
  bottom: auto;
  right: 6px;
  top: 6px;
  width: 24px;
  height: 24px;
  background: rgba(17, 20, 26, 0.28);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.compact .select-mark.on {
  background: var(--brand);
  border-color: var(--brand);
}
.compact-private {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(17, 20, 26, 0.5);
  color: #fff;
}
.selectable .compact-private {
  display: none;
}
/* 生成封面: 纸色 + 衬线书名 + 细线, 不再是渐变色块 */
.compact .cover-fallback {
  justify-content: flex-start;
  gap: 0;
  padding: 14% 12% 10%;
  border-left: 0;
  color: var(--ink);
  background: var(--paper);
}
.compact .cover-fallback::before {
  content: '';
  height: 1px;
  margin-bottom: 12%;
  background: currentColor;
  opacity: 0.35;
}
.compact .cover-fallback-title {
  font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.03em;
  -webkit-line-clamp: 5;
}
.compact .cover-fallback-author {
  margin-top: auto;
  font-size: 10px;
  opacity: 0.7;
}
.tone-0 { --paper: var(--cover-paper-0); --ink: var(--cover-ink-0); }
.tone-1 { --paper: var(--cover-paper-1); --ink: var(--cover-ink-1); }
.tone-2 { --paper: var(--cover-paper-2); --ink: var(--cover-ink-2); }
.tone-3 { --paper: var(--cover-paper-3); --ink: var(--cover-ink-3); }
.tone-4 { --paper: var(--cover-paper-4); --ink: var(--cover-ink-4); }
.tone-5 { --paper: var(--cover-paper-5); --ink: var(--cover-ink-5); }
:root[data-theme='dark'] .compact .cover-fallback {
  color: var(--ink);
  background: var(--paper);
}
.compact .title {
  margin-top: 9px;
  font-size: 13.5px;
  line-height: 1.38;
}
.pinned-mark {
  display: inline-block;
  margin-right: 3px;
  vertical-align: -1px;
  color: var(--brand);
}
.meta {
  display: flex;
  align-items: center;
  margin-top: 2px;
  margin-right: -10px;
}
.meta-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.meta-done {
  color: var(--success);
}
/* 36×36 按钮, 上下负边距不撑高作者行; 热区再外扩到 ≥44px */
.meta-more {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  margin: -6px 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-3);
}
/* 热区外扩到 ≥44px 高 */
.meta-more::before {
  content: '';
  position: absolute;
  inset: -4px;
}
.meta-more:active {
  background: var(--surface-3);
}
.meta-more:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .book-card,
  .book-card:hover {
    transform: none;
  }
}
</style>
