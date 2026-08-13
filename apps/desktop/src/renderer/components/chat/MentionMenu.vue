<!-- apps/web/src/components/chat/MentionMenu.vue -->
<!-- Popup list of file paths shown when user types @ in the Composer textarea. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { iconSvg } from '@moonshot-ai/app-client/icons';
import type { FileItem } from '../../types';

// Re-exported for the .vue consumers (Composer / ChatDock / ConversationPane)
// that import FileItem from this component.
export type { FileItem };

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

// Scroll-linked edge fades (the dock work panel's alpha-mask vocabulary):
// dissolve toward an edge only while more content exists beyond it.
const scrollEl = ref<HTMLElement | null>(null);
const scrolledUp = ref(false);
const canScrollDown = ref(false);
let resizeObserver: ResizeObserver | null = null;

// The overlay scroll thumb: the native bar is hidden (it used to eat 6px of
// row width, skewing the rows' right inset), so this floating thumb is the
// only scroll affordance. Geometry clamps to the straight band inside the
// menu frame's corner arcs — the same band the old webkit track carved out.
const thumb = ref<{ top: number; height: number } | null>(null);

function updateScrollState(): void {
  const el = scrollEl.value;
  if (!el) return;
  scrolledUp.value = el.scrollTop > 0;
  canScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight + 1) {
    thumb.value = null;
    return;
  }
  const menuStyle = getComputedStyle(el);
  const inset =
    parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-track-inset')) || 0;
  const minThumb =
    parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-thumb-min')) || 24;
  const track = clientHeight - inset * 2;
  const height = Math.max(minThumb, (clientHeight / scrollHeight) * track);
  const maxScroll = scrollHeight - clientHeight;
  const top = el.offsetTop + inset + (scrollTop / maxScroll) * (track - height);
  thumb.value = { top, height };
}

function onScroll(): void {
  updateScrollState();
}

let activeThumbCleanup: (() => void) | null = null;

// The thumb is the only scroll affordance (the native bar is hidden), so it
// drags: pointer capture + proportional scrollTop.
function onThumbPointerDown(event: PointerEvent): void {
  const el = scrollEl.value;
  const current = thumb.value;
  if (!el || !current) return;
  event.preventDefault();
  // A drag belongs to the pointer that started it: a second touch must not
  // move the thumb or end the session. End any stale session first.
  activeThumbCleanup?.();
  const dragPointerId = event.pointerId;
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  const menuStyle = getComputedStyle(el);
  const inset = parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-track-inset')) || 0;
  const trackRange = el.clientHeight - inset * 2 - current.height;
  const scrollRange = el.scrollHeight - el.clientHeight;
  const startY = event.clientY;
  const startScrollTop = el.scrollTop;
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== dragPointerId || trackRange <= 0) return;
    el.scrollTop = startScrollTop + ((ev.clientY - startY) / trackRange) * scrollRange;
  };
  // No `once: true` — a foreign pointer's up/cancel must be ignored without
  // deregistering the listener before the drag pointer's own arrives.
  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== dragPointerId) return;
    stop();
  };
  const stop = (): void => {
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointercancel', onUp);
    if (activeThumbCleanup === stop) activeThumbCleanup = null;
  };
  activeThumbCleanup = stop;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  // A touch gesture can be cancelled without a pointerup — same cleanup.
  window.addEventListener('pointercancel', onUp);
}


const maskImage = computed(() => {
  const up = scrolledUp.value;
  const down = canScrollDown.value;
  // The fade distance rides the shared token — the mask is JS-built, so
  // check:style can't see it; var() keeps it on the spacing scale.
  const fade = 'var(--menu-scroll-fade)';
  if (up && down) return `linear-gradient(to bottom, transparent 0, black ${fade}, black calc(100% - ${fade}), transparent 100%)`;
  if (up) return `linear-gradient(to bottom, transparent, black ${fade})`;
  if (down) return `linear-gradient(to top, transparent, black ${fade})`;
  return undefined;
});

onMounted(() => {
  updateScrollState();
  if (typeof ResizeObserver === 'function' && scrollEl.value) {
    resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scrollEl.value);
  }
});
onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  activeThumbCleanup?.();
});

// Keep the active row inside the scrollport: arrow-key navigation (and the
// reset to row 0 after each new search result) must pull off-screen rows
// back into view. Manual scrollTop math — scrollIntoView would also scroll
// ancestor scrollers (the conversation behind the menu).
function scrollActiveIntoView(): void {
  const el = scrollEl.value;
  if (!el) return;
  const row = el.querySelectorAll<HTMLElement>('[role="option"]')[props.activeIndex];
  if (!row) return;
  const elRect = el.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const top = rowRect.top - elRect.top + el.scrollTop;
  const bottom = top + rowRect.height;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
}

watch(
  () => props.activeIndex,
  () => {
    void nextTick(scrollActiveIntoView);
  },
);
watch(
  () => props.items,
  () => {
    void nextTick(() => {
      updateScrollState();
      scrollActiveIntoView();
    });
  },
);

// ---------------------------------------------------------------------------
// File-type glyphs: small line-SVG icons (viewBox 0 0 16 16) keyed off the
// extension. Categories: folder, code, doc/markdown, image, generic.
// Subtle + muted; never an emoji.
// ---------------------------------------------------------------------------

const ICON_FOLDER = iconSvg('folder', 'sm');
const ICON_CODE = iconSvg('code', 'sm');
const ICON_DOC = iconSvg('file-text', 'sm');
const ICON_IMAGE = iconSvg('image', 'sm');
const ICON_GENERIC = iconSvg('file', 'sm');

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
  <div class="mention-menu" data-menu-frame>
    <!-- Loading / no-match notes are live status regions, not listbox items. -->
    <div v-if="props.loading" class="mention-state dim" role="status">{{ t('mention.searching') }}</div>
    <div v-else-if="props.items.length === 0" class="mention-state dim" role="status">{{ t('mention.noMatch') }}</div>
    <div
      id="composer-mention-menu"
      v-show="!props.loading && props.items.length > 0"
      ref="scrollEl"
      class="mention-scroll"
      role="listbox"
      :style="{ maskImage }"
      @scroll="onScroll"
    >
      <!-- File items -->
      <div
        v-for="(item, i) in props.items"
        :key="item.path"
        :id="`composer-mention-option-${i}`"
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
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && !props.loading && props.items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
  </div>
</template>

<style scoped>
/* `[data-menu-frame]` raises the frame's specificity so the redesign's
   surface + shadow win over any global menu styles (the listbox role and
   the controlled id now live on the inner scroll container). Chrome shared
   with the add menu:
   the dock panel's frosted material and the composer card's corner geometry.
   No overflow clip on the frame — the scroll container below clips rows
   exactly at their own edge, and their corner-shaped caps sit ~4px inside
   the frame's corner curve on their own. */
.mention-menu[data-menu-frame] {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  padding: var(--space-1-5) var(--space-3);
  background: var(--color-menu-bg-frost);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-composer);
  corner-shape: var(--corner-shape-composer);
  box-shadow: var(--shadow-menu);
  z-index: var(--z-dropdown);
}

/* The real scroll container. overflow-y: auto forces overflow-x: auto, so
   the scrollport clips horizontally at its padding box: stretch the box 6px
   outward (margin −6, padding 6) so that clip lands exactly on the rows'
   outer edge instead of shearing their caps 12px in. The native scrollbar is
   hidden entirely — a layout scrollbar eats 6px of row width (and shows a
   track gutter even when short) and skewed the rows' right inset; the
   overlay thumb floating over the menu (see .scroll-thumb) is the scroll
   affordance instead. */
.mention-scroll {
  max-height: var(--p-mention-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
}
.mention-scroll::-webkit-scrollbar { display: none; }
/* The overlay thumb: floats at the menu's right edge, pointer-transparent,
   semi-transparent at rest and deeper on menu hover (the old webkit bar's
   vocabulary). Geometry is computed in updateScrollState. */
.scroll-thumb {
  position: absolute;
  right: var(--menu-scrollbar-edge);
  width: var(--menu-scrollbar-width);
  border-radius: var(--radius-full);
  background: var(--color-menu-scrollbar);
  transition: background var(--duration-base) var(--ease-out);
  /* Interactive: it is the only scroll affordance, so it must drag. */
  cursor: default;
  /* Without this the browser may claim a touch drag as a page pan and
     pointercancel the session mid-drag. */
  touch-action: none;
  z-index: var(--z-raised);
}
.mention-menu:hover .scroll-thumb {
  background: var(--color-menu-scrollbar-hover);
}
/* The 3px visual bar gets a wider invisible hit strip for dragging. */
.scroll-thumb::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--space-2));
  right: 0;
}

/* Same 16px text column as the rows (scroll container's content box starts
   at 12px). */
.mention-state {
  padding: var(--space-2) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
}

.dim {
  color: var(--color-text-muted);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  /* Box hugs 6px from the menu edge while the content lands on the
     composer's 16px text column; radius = composer radius − 6 stays
     concentric with the menu frame. The 0.5px transparent border is a
     workaround: without a border, Chromium paints the corner-shaped
     background as a plain rect and the menu frame's corner shears the
     row's ends off. Padding is narrowed by the border width so neither
     the text column nor the row height moves. */
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--menu-row-padding-block) var(--menu-row-padding-inline);
  border: var(--p-hairline) solid transparent;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
  border-radius: var(--radius-menu-row);
  corner-shape: var(--corner-shape-menu);
}

.mention-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--muted);
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
  color: var(--color-text-strong);
}

.mention-item:hover {
  background: var(--color-hover);
}
.mention-item:hover .mention-name,
.mention-item.active .mention-name {
  color: var(--color-text-strong);
}
.mention-item.active {
  background: var(--color-selected);
}

/* The declared seam between stacked rows, so adjacent hover/selected
   backgrounds don't stick together. */
.mention-item + .mention-item {
  margin-top: var(--menu-rows-seam);
}

/* Touch: menu rows meet the 44px minimum hit height — a direct min-height,
   since fixed padding alone falls short at the Small font size. */
@media (hover: none) {
  .mention-item {
    min-height: var(--touch-target-min);
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}

.mention-name {
  color: var(--color-text);
  font-weight: 500;
  min-width: 80px;
  flex-shrink: 0;
}

.mention-path {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
