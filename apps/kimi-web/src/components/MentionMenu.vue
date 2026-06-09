<!-- apps/kimi-web/src/components/MentionMenu.vue -->
<!-- Popup list of file paths shown when user types @ in the Composer textarea. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';

export interface FileItem {
  path: string;
  name: string;
}

const props = defineProps<{
  items: FileItem[];
  activeIndex: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [item: FileItem];
  hover: [index: number];
}>();

const { t } = useI18n();

// ---------------------------------------------------------------------------
// File-type glyphs: small line-SVG icons (viewBox 0 0 16 16) keyed off the
// extension. Categories: folder, code, doc/markdown, image, generic.
// Subtle + muted; never an emoji.
// ---------------------------------------------------------------------------

const ICON_FOLDER = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.2 1.4H13a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"/></svg>`;
const ICON_CODE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" xmlns="http://www.w3.org/2000/svg"><polyline points="5.5,5 2.5,8 5.5,11"/><polyline points="10.5,5 13.5,8 10.5,11"/></svg>`;
const ICON_DOC = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" xmlns="http://www.w3.org/2000/svg"><path d="M4 1.5h5l3 3v10H4z"/><line x1="6" y1="8" x2="11" y2="8"/><line x1="6" y1="10.5" x2="11" y2="10.5"/></svg>`;
const ICON_IMAGE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1.1"/><path d="M3 12l3.5-3.5L9 11l2-2 3 3"/></svg>`;
const ICON_GENERIC = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" xmlns="http://www.w3.org/2000/svg"><path d="M4 1.5h5l3 3v10H4z"/><polyline points="9,1.5 9,4.5 12,4.5"/></svg>`;

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'json', 'py', 'go', 'rs',
  'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'rb', 'php', 'swift',
  'sh', 'bash', 'zsh', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'sql',
  'yaml', 'yml', 'toml', 'lua', 'dart', 'scala', 'clj', 'ex', 'exs',
]);
const DOC_EXT = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'pdf', 'doc', 'docx']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function fileIcon(item: FileItem): string {
  const path = item.path;
  // Trailing slash → folder.
  if (path.endsWith('/')) return ICON_FOLDER;
  const base = item.name || path.split('/').pop() || path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ext) return ICON_GENERIC;
  if (CODE_EXT.has(ext)) return ICON_CODE;
  if (DOC_EXT.has(ext)) return ICON_DOC;
  if (IMAGE_EXT.has(ext)) return ICON_IMAGE;
  return ICON_GENERIC;
}
</script>

<template>
  <div class="mention-menu" role="listbox">
    <!-- Loading state -->
    <div v-if="props.loading" class="mention-state dim">{{ t('mention.searching') }}</div>

    <!-- Empty state (not loading, no items) -->
    <div v-else-if="props.items.length === 0" class="mention-state dim">{{ t('mention.noMatch') }}</div>

    <!-- File items -->
    <div
      v-for="(item, i) in props.items"
      v-else
      :key="item.path"
      class="mention-item"
      :class="{ active: i === props.activeIndex }"
      role="option"
      :aria-selected="i === props.activeIndex"
      @mouseenter="emit('hover', i)"
      @mousedown.prevent="emit('select', item)"
    >
      <!-- file-type glyph (line-SVG) -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span class="mention-icon" v-html="fileIcon(item)" aria-hidden="true" />
      <span class="mention-name">{{ item.name }}</span>
      <span class="mention-path">{{ item.path }}</span>
    </div>
  </div>
</template>

<style scoped>
.mention-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  z-index: 100;
  max-height: 220px;
  overflow-y: auto;
}

.mention-state {
  padding: 8px 12px;
  font-family: var(--mono);
  font-size: 12px;
}

.dim {
  color: var(--muted);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12px;
  border-bottom: 1px solid var(--line2);
}

.mention-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--faint);
  flex-shrink: 0;
}

/* Pin every glyph to the same 14px box so rows line up regardless of icon kind. */
.mention-icon :deep(svg) {
  width: 13px;
  height: 13px;
  display: block;
}

.mention-item:hover .mention-icon,
.mention-item.active .mention-icon {
  color: var(--muted);
}

.mention-item:last-child {
  border-bottom: none;
}

.mention-item:hover,
.mention-item.active {
  background: var(--soft);
}

.mention-name {
  color: var(--ink);
  font-weight: 600;
  min-width: 80px;
  flex-shrink: 0;
}

.mention-path {
  color: var(--dim);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
