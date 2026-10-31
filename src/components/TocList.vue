<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n'

export interface TocItem {
  label: string
  href?: string
  subitems?: TocItem[] | null
}

const props = defineProps<{
  items: TocItem[]
  currentHref?: string
  depth?: number
}>()

defineEmits<{
  navigate: [href: string]
}>()

/** 每个有子项的节点默认收起；顶层（depth 0）默认展开 */
const collapsedSet = ref<Set<string>>(new Set())

/** 生成稳定 key：depth-index 组合，递归时拼父路径 */
function nodeKey(depth: number, index: number, parentKey?: string): string {
  return parentKey ? `${parentKey}.${depth}-${index}` : `${depth}-${index}`
}

function hasChildren(item: TocItem): boolean {
  return !!item.subitems?.length
}

function isCollapsed(key: string): boolean {
  return collapsedSet.value.has(key)
}

function toggleCollapse(key: string) {
  if (collapsedSet.value.has(key)) collapsedSet.value.delete(key)
  else collapsedSet.value.add(key)
}

/** 当子树包含当前条目时，父节点也应高亮展开 */
function subtreeContainsCurrent(items: TocItem[] | null | undefined, href?: string): boolean {
  if (!href || !items) return false
  for (const item of items) {
    if (item.href === href) return true
    if (subtreeContainsCurrent(item.subitems, href)) return true
  }
  return false
}
</script>

<template>
  <ul class="toc-list" :class="{ 'toc-root': !depth }">
    <li v-for="(item, i) in items" :key="i">
      <div
        class="toc-row"
        :class="{ active: item.href && item.href === currentHref }"
        :style="{ paddingLeft: (depth ?? 0) * 16 + 8 + 'px' }"
      >
        <!-- 折叠箭头 -->
        <button
          v-if="hasChildren(item)"
          type="button"
          class="toc-toggle"
          :aria-label="isCollapsed(nodeKey(depth ?? 0, i)) ? t('common.expand') : t('common.collapse')"
          @click.stop="toggleCollapse(nodeKey(depth ?? 0, i))"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
            :style="{ transform: isCollapsed(nodeKey(depth ?? 0, i)) ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform .15s' }">
            <path fill="currentColor" d="M5.5 3.5a.8.8 0 0 1 1.2-.1l4 4a.8.8 0 0 1 0 1.2l-4 4a.8.8 0 1 1-1.2-1.2L8.8 8 5.5 4.7a.8.8 0 0 1-.1-1.2z" />
          </svg>
        </button>
        <!-- 无子项时占位，保持对齐 -->
        <span v-else class="toc-toggle-placeholder" />
        <!-- 标题 -->
        <button
          class="toc-item"
          :class="{ active: item.href && item.href === currentHref, disabled: !item.href }"
          :aria-current="item.href && item.href === currentHref ? 'location' : undefined"
          @click="item.href && $emit('navigate', item.href)"
        >
          {{ item.label?.trim() || t('reader.untitled') }}
        </button>
      </div>
      <!-- 子级：默认收起；但如果包含当前条目则自动展开 -->
      <TocList
        v-if="hasChildren(item) && !isCollapsed(nodeKey(depth ?? 0, i))"
        :items="item.subitems!"
        :current-href="currentHref"
        :depth="(depth ?? 0) + 1"
        @navigate="$emit('navigate', $event)"
      />
      <!-- 当前条目在子级里但子级被收起时，强制展开（不改变 collapsedSet，仅渲染） -->
      <TocList
        v-else-if="hasChildren(item) && isCollapsed(nodeKey(depth ?? 0, i)) && subtreeContainsCurrent(item.subitems, currentHref)"
        :items="item.subitems!"
        :current-href="currentHref"
        :depth="(depth ?? 0) + 1"
        @navigate="$emit('navigate', $event)"
      />
    </li>
  </ul>
</template>

<style scoped>
.toc-list {
  list-style: none;
}
.toc-root {
  padding: 4px 0;
}
.toc-row {
  display: flex;
  align-items: flex-start;
  min-height: var(--control-h);
  border-radius: 6px;
}
.toc-row.active {
  background: var(--brand-light);
}
.toc-toggle {
  flex-shrink: 0;
  width: 18px;
  height: 22px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-top: 4px;
}
.toc-toggle:hover {
  color: var(--text);
}
.toc-toggle-placeholder {
  flex-shrink: 0;
  width: 18px;
}
.toc-item {
  flex: 1;
  min-height: 22px;
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 5px 8px 5px 0;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  cursor: pointer;
}
.toc-item:hover {
  color: var(--text);
}
.toc-row.active .toc-item {
  color: var(--brand);
  font-weight: 500;
}
.toc-item.disabled {
  cursor: default;
  color: var(--text-3);
}
</style>
