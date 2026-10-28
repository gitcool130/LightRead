<script setup lang="ts">
/**
 * 一页 PDF 上的绘图批注层: 画笔 / 荧光笔 / 矩形 / 椭圆 / 直线 / 箭头 / 文字框。
 *
 * 纯展示 + 就地编辑文字框, 交互 (按下 / 拖动 / 选择) 由 PaperReaderView 统一处理,
 * 这样翻页、缩放、双页与连续滚动的坐标换算只写一处。所有坐标都是页内坐标
 * (缩放 1), 通过 viewBox 映射到实际显示尺寸。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  annoBounds, arrowHeadPoints, inkPathD,
  type DrawAnno, type NoteAnno,
} from '../services/pdfAnno'

const props = defineProps<{
  /** 页面尺寸 (页坐标) */
  w: number
  h: number
  /** 页坐标 → 显示 px 的缩放 */
  sx: number
  sy: number
  items: Array<{ id: string; d: DrawAnno }>
  draft: DrawAnno | null
  activeId: string | null
  editingId: string | null
  editingText: string
  /** 工具激活时这一层才接收指针事件 */
  interactive: boolean
}>()

const emit = defineEmits<{
  (e: 'text-input', value: string): void
  (e: 'text-commit'): void
}>()

const viewBox = computed(() => `0 0 ${Math.max(1, props.w)} ${Math.max(1, props.h)}`)

/** 形状与笔迹走 SVG; 文字框用 HTML, 才能自然换行 */
const vectorItems = computed(() => props.items.filter(it => it.d.t !== 'note'))
const noteItems = computed(() =>
  props.items.filter((it): it is { id: string; d: NoteAnno } => it.d.t === 'note'),
)

const draftVector = computed(() => (props.draft && props.draft.t !== 'note' ? props.draft : null))

const activeBox = computed(() => {
  if (!props.activeId) return null
  const hit = props.items.find(it => it.id === props.activeId)
  if (!hit || hit.d.t === 'note') return null
  const b = annoBounds(hit.d)
  return {
    left: `${b.x * props.sx}px`,
    top: `${b.y * props.sy}px`,
    width: `${Math.max(1, b.w * props.sx)}px`,
    height: `${Math.max(1, b.h * props.sy)}px`,
  }
})

const noteStyle = (d: NoteAnno) => ({
  left: `${d.x * props.sx}px`,
  top: `${d.y * props.sy}px`,
  width: `${Math.max(24, d.w * props.sx)}px`,
  minHeight: `${Math.max(18, d.h * props.sy)}px`,
  fontSize: `${Math.max(8, d.s * props.sy)}px`,
  color: d.c,
})

const strokeWidth = (d: DrawAnno) => Math.max(0.4, (d as { w: number }).w)

const textarea = ref<HTMLTextAreaElement>()
/** 同一时刻只会有一个文字框处于编辑态, 用函数 ref 抓住它 */
const setEditor = (el: unknown) => {
  textarea.value = (el as HTMLTextAreaElement | null) ?? undefined
}

watch(
  () => props.editingId,
  async id => {
    if (!id) return
    await nextTick()
    const el = textarea.value
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  },
  { immediate: true },
)

const onEditKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('text-commit')
    return
  }
  // Ctrl/Cmd + Enter 结束编辑; 单独 Enter 留给换行
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    emit('text-commit')
  }
}
</script>

<template>
  <div class="anno-layer" :class="{ live: interactive }">
    <svg class="anno-svg" :viewBox="viewBox" preserveAspectRatio="none" aria-hidden="true">
      <g v-for="it in vectorItems" :key="it.id">
        <path
          v-if="it.d.t === 'ink'"
          :d="inkPathD(it.d.pts)"
          :stroke="it.d.c"
          :stroke-width="strokeWidth(it.d)"
          :opacity="it.d.a"
          :class="{ marker: it.d.w > 5 }"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <rect
          v-else-if="it.d.t === 'rect'"
          :x="Math.min(it.d.x1, it.d.x2)"
          :y="Math.min(it.d.y1, it.d.y2)"
          :width="Math.abs(it.d.x2 - it.d.x1)"
          :height="Math.abs(it.d.y2 - it.d.y1)"
          :stroke="it.d.c"
          :stroke-width="strokeWidth(it.d)"
          :opacity="it.d.a"
          fill="none"
        />
        <ellipse
          v-else-if="it.d.t === 'ellipse'"
          :cx="(it.d.x1 + it.d.x2) / 2"
          :cy="(it.d.y1 + it.d.y2) / 2"
          :rx="Math.abs(it.d.x2 - it.d.x1) / 2"
          :ry="Math.abs(it.d.y2 - it.d.y1) / 2"
          :stroke="it.d.c"
          :stroke-width="strokeWidth(it.d)"
          :opacity="it.d.a"
          fill="none"
        />
        <g v-else-if="it.d.t === 'arrow'">
          <line
            :x1="it.d.x1"
            :y1="it.d.y1"
            :x2="it.d.x2"
            :y2="it.d.y2"
            :stroke="it.d.c"
            :stroke-width="strokeWidth(it.d)"
            :opacity="it.d.a"
            stroke-linecap="round"
          />
          <polygon
            :points="arrowHeadPoints(it.d.x1, it.d.y1, it.d.x2, it.d.y2, strokeWidth(it.d))"
            :fill="it.d.c"
            :opacity="it.d.a"
          />
        </g>
        <line
          v-else-if="it.d.t === 'line'"
          :x1="it.d.x1"
          :y1="it.d.y1"
          :x2="it.d.x2"
          :y2="it.d.y2"
          :stroke="it.d.c"
          :stroke-width="strokeWidth(it.d)"
          :opacity="it.d.a"
          stroke-linecap="round"
        />
      </g>

      <!-- 正在画的预览 -->
      <g v-if="draftVector?.t === 'ink'" class="anno-draft">
        <path
          :d="inkPathD(draftVector.pts)"
          :stroke="draftVector.c"
          :stroke-width="draftVector.w"
          :opacity="draftVector.a"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </g>
      <g v-else-if="draftVector">
        <rect
          v-if="draftVector.t === 'rect'"
          :x="Math.min(draftVector.x1, draftVector.x2)"
          :y="Math.min(draftVector.y1, draftVector.y2)"
          :width="Math.abs(draftVector.x2 - draftVector.x1)"
          :height="Math.abs(draftVector.y2 - draftVector.y1)"
          :stroke="draftVector.c"
          :stroke-width="draftVector.w"
          :opacity="draftVector.a"
          fill="none"
        />
        <ellipse
          v-else-if="draftVector.t === 'ellipse'"
          :cx="(draftVector.x1 + draftVector.x2) / 2"
          :cy="(draftVector.y1 + draftVector.y2) / 2"
          :rx="Math.abs(draftVector.x2 - draftVector.x1) / 2"
          :ry="Math.abs(draftVector.y2 - draftVector.y1) / 2"
          :stroke="draftVector.c"
          :stroke-width="draftVector.w"
          :opacity="draftVector.a"
          fill="none"
        />
        <template v-else-if="draftVector.t === 'arrow'">
          <line
            :x1="draftVector.x1"
            :y1="draftVector.y1"
            :x2="draftVector.x2"
            :y2="draftVector.y2"
            :stroke="draftVector.c"
            :stroke-width="draftVector.w"
            :opacity="draftVector.a"
            stroke-linecap="round"
          />
          <polygon
            :points="arrowHeadPoints(draftVector.x1, draftVector.y1, draftVector.x2, draftVector.y2, draftVector.w)"
            :fill="draftVector.c"
            :opacity="draftVector.a"
          />
        </template>
        <line
          v-else-if="draftVector.t === 'line'"
          :x1="draftVector.x1"
          :y1="draftVector.y1"
          :x2="draftVector.x2"
          :y2="draftVector.y2"
          :stroke="draftVector.c"
          :stroke-width="draftVector.w"
          :opacity="draftVector.a"
          stroke-linecap="round"
        />
      </g>
    </svg>

    <!-- 文字批注框: 未编辑时是文本, 编辑时是输入框 -->
    <div
      v-for="it in noteItems"
      :key="it.id"
      class="anno-text-box"
      :class="{ active: it.id === activeId }"
      :style="noteStyle(it.d)"
    >
      <textarea
        v-if="it.id === editingId"
        :ref="setEditor"
        class="anno-text-box-input"
        :value="editingText"
        :style="{ fontSize: `${Math.max(8, it.d.s * sy)}px`, color: it.d.c }"
        @input="emit('text-input', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onEditKeydown"
        @blur="emit('text-commit')"
      />
      <template v-else>{{ it.d.text }}</template>
    </div>

    <div v-if="activeBox" class="anno-sel" :style="activeBox" aria-hidden="true" />
  </div>
</template>

<style scoped>
.anno-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.anno-layer.live {
  pointer-events: auto;
  cursor: crosshair;
}
.anno-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.anno-svg .marker {
  mix-blend-mode: multiply;
}
.anno-text-box {
  position: absolute;
  padding: 2px 4px;
  border-radius: var(--radius-xs);
  border: 1px solid transparent;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.35;
  pointer-events: none;
}
.anno-text-box.active {
  border-color: currentColor;
  background: rgba(255, 255, 255, 0.86);
}
.anno-text-box-input {
  display: block;
  width: 100%;
  min-height: 2.4em;
  padding: 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  font: inherit;
  line-height: 1.35;
  pointer-events: auto;
}
.anno-sel {
  position: absolute;
  border: 1px dashed var(--brand);
  border-radius: var(--radius-xs);
}
</style>
