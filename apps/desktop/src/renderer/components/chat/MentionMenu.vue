<!-- apps/web/src/components/chat/MentionMenu.vue -->
<!-- Popup list shown when the user types @ in the Composer: file/folder
     matches from the daemon search (top section) plus session skills (bottom
     section, when the host editor offers them). -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Spinner } from '@moonshot-ai/app-ui';
import { fileMentionIconSvg, mentionIconSvg } from '@moonshot-ai/app-composer';
import type { MentionItem } from '@moonshot-ai/app-client/composables';
import type { FileItem } from '../../types';

// Re-exported for the .vue consumers (Composer / ChatDock / ConversationPane)
// that import FileItem from this component.
export type { FileItem };

const props = defineProps<{
  /** Flat row list — files/folders first, then skills. */
  items: MentionItem[];
  activeIndex: number;
  loading: boolean;
  /** The file rows belong to an older query (a new search is pending) —
   *  they stay visible but dimmed rather than flashing an empty state. */
  stale?: boolean;
}>();

const emit = defineEmits<{
  select: [item: MentionItem];
  hover: [index: number];
}>();

const { t } = useI18n();

// Section split: skills always trail the flat list. The section headers only
// appear when BOTH groups are present — a single group reads fine bare.
const fileRows = computed(() => props.items.filter((item): item is Extract<MentionItem, { kind: 'file' | 'folder' }> => item.kind !== 'skill'));
const skillRows = computed(() => props.items.filter((item): item is Extract<MentionItem, { kind: 'skill' }> => item.kind === 'skill'));

function rowIcon(item: MentionItem): string {
  if (item.kind === 'skill') return mentionIconSvg('skill', '', item.skill.name);
  return fileMentionIconSvg(item.file.path, item.file.name, item.kind === 'folder');
}

/** The meta text after a file/folder name: its containing directory only —
 *  the full path is noise once the name carries the basename. A root-level
 *  entry shows nothing. */
function rowDir(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

// Scroll-linked edge fades (the dock work panel's alpha-mask vocabulary):
// dissolve toward an edge only while more content exists beyond it.
const scrollEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
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

// Viewport clamp: the frame hangs above the input area with a fixed token cap
// on the scrollport, but layouts where the composer sits high in the pane
// (workspace home) leave less room than the cap — shrink the scrollport to
// the space actually available above the positioning parent, so rows scroll
// instead of the frame overflowing the window's top edge. The menu always
// opens upward (autocomplete convention); recomputed on window resize and
// whenever the parent resizes (composer auto-grow). Bounds come from the
// VISUAL viewport — on iOS the software keyboard shifts and shrinks it
// without touching window.innerHeight (the App.vue --app-height recipe).
const scrollMaxHeight = ref('');

function clampScrollToViewport(): void {
  const menu = menuEl.value;
  const scroll = scrollEl.value;
  const parent = menu?.offsetParent as HTMLElement | null;
  if (!menu || !scroll || !parent) return;
  const menuStyle = getComputedStyle(menu);
  const gap = parseFloat(menuStyle.getPropertyValue('--space-2')) || 8; // frame ↔ composer offset
  const margin = parseFloat(menuStyle.getPropertyValue('--space-2')) || 8; // viewport breathing room
  const chrome = (parseFloat(menuStyle.paddingTop) || 0) + (parseFloat(menuStyle.paddingBottom) || 0);
  const cap = parseFloat(getComputedStyle(scroll).getPropertyValue('--p-mention-menu-h')) || Number.POSITIVE_INFINITY;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const available = parent.getBoundingClientRect().top - viewportTop - gap - margin - chrome;
  scrollMaxHeight.value = `${Math.max(Math.floor(Math.min(cap, available)), 0)}px`;
  void nextTick(() => {
    updateScrollState();
    scrollActiveIntoView();
  });
}

onMounted(() => {
  clampScrollToViewport();
  updateScrollState();
  if (typeof ResizeObserver === 'function' && scrollEl.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // The positioning parent (.cin-wrap) grows with the composer's content
        // and shifts with window-driven layout — re-clamp the scrollport cap;
        // the scrollport itself only needs the scroll-state refresh.
        if (entry.target === scrollEl.value) updateScrollState();
        else clampScrollToViewport();
      }
    });
    resizeObserver.observe(scrollEl.value);
    const parent = menuEl.value?.offsetParent;
    if (parent) resizeObserver.observe(parent);
  }
  window.addEventListener('resize', clampScrollToViewport);
  // The visual viewport's own events (iOS keyboard, pinch pan) don't surface
  // as window resize — the clamp must recompute on both.
  window.visualViewport?.addEventListener('resize', clampScrollToViewport);
  window.visualViewport?.addEventListener('scroll', clampScrollToViewport);
});
onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  activeThumbCleanup?.();
  window.removeEventListener('resize', clampScrollToViewport);
  window.visualViewport?.removeEventListener('resize', clampScrollToViewport);
  window.visualViewport?.removeEventListener('scroll', clampScrollToViewport);
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
</script>

<template>
  <div ref="menuEl" class="mention-menu" data-menu-frame>
    <!-- The full-area loading note only appears when there is nothing to
         show; with rows visible, searching gets a corner spinner instead and
         the current candidates stay on screen. -->
    <div v-if="props.loading && props.items.length === 0" class="mention-state dim" role="status">{{ t('mention.searching') }}</div>
    <div v-else-if="props.items.length === 0" class="mention-state dim" role="status">{{ t('mention.noMatch') }}</div>
    <Spinner v-if="props.loading && props.items.length > 0" class="mention-spin" size="xs" />
    <div
      id="composer-mention-menu"
      v-show="props.items.length > 0"
      ref="scrollEl"
      class="mention-scroll"
      role="listbox"
      :style="{ maskImage, maxHeight: scrollMaxHeight }"
      @scroll="onScroll"
    >
      <!-- Files / folders (flat indices 0..fileRows.length-1) -->
      <template v-if="fileRows.length > 0">
        <div v-if="skillRows.length > 0" class="mention-section">{{ t('mention.files') }}</div>
        <div
          v-for="(row, i) in fileRows"
          :key="row.file.path"
          :id="`composer-mention-option-${i}`"
          class="mention-item"
          :class="{ active: i === props.activeIndex, stale: props.stale }"
          role="option"
          :aria-selected="i === props.activeIndex"
          @mouseenter="emit('hover', i)"
          @mousedown.prevent="emit('select', row)"
        >
          <!-- file-type glyph (line-SVG) -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
          <span class="mention-name">{{ row.file.name }}</span>
          <span v-if="rowDir(row.file.path)" class="mention-meta">{{ rowDir(row.file.path) }}</span>
        </div>
      </template>

      <!-- Skills (flat indices fileRows.length..) -->
      <template v-if="skillRows.length > 0">
        <div v-if="fileRows.length > 0" class="mention-section">{{ t('mention.skills') }}</div>
        <div
          v-for="(row, j) in skillRows"
          :key="row.skill.name"
          :id="`composer-mention-option-${fileRows.length + j}`"
          class="mention-item"
          :class="{ active: fileRows.length + j === props.activeIndex }"
          role="option"
          :aria-selected="fileRows.length + j === props.activeIndex"
          @mouseenter="emit('hover', fileRows.length + j)"
          @mousedown.prevent="emit('select', row)"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
          <span class="mention-name">{{ row.skill.name }}</span>
          <span class="mention-meta">{{ row.skill.description }}</span>
        </div>
      </template>
    </div>
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && props.items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
  </div>
</template>

<style scoped>
/* `[data-menu-frame]` raises the frame's specificity so the redesign's
   surface + shadow win over any global menu styles (the listbox role and
   the controlled id now live on the inner scroll container). Chrome shared
   with the add menu:
   the dock panel's frosted material and a plain 12px corner (no
   superellipse). No overflow clip on the frame — the scroll container below
   clips rows exactly at their own edge. */
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
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  z-index: var(--z-dropdown);
}

/* The real scroll container. overflow-y: auto forces overflow-x: auto, so
   the scrollport clips horizontally at its padding box: stretch the box 6px
   outward (margin −6, padding 6) so that clip lands exactly on the rows'
   outer edge instead of shearing their caps in. The native scrollbar is
   hidden entirely — a layout scrollbar eats row width (and shows a track
   gutter even when short) and skews the rows' right inset; the overlay
   thumb floating over the menu (see .scroll-thumb) is the scroll
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

/* The 16px text column as the rows (scroll container's content box starts
   at 12px). */
.mention-state {
  padding: var(--space-2) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
}

/* Group caption between the two sections — quiet, same text column. */
.mention-section {
  padding: var(--space-1) var(--space-1) var(--space-05);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
}

/* The searching indicator while candidates stay visible: pinned to the
   frame's top-right corner so the list never shifts. */
.mention-spin {
  position: absolute;
  top: var(--space-2);
  right: var(--space-3);
  color: var(--color-text-muted);
  z-index: var(--z-raised);
}

.dim {
  color: var(--color-text-muted);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  /* Row caps hug the frame's padding edge with a −hug outreach (the frame
     pads 10px inline, so the caps land 4px inside the edge); the
     --radius-menu-row caps stay concentric with the 12px frame. */
  margin: 0 calc(-1 * var(--menu-row-hug));
  /* Dense rows: 8px inline padding (down from the shared 10px token — the
     mention menu no longer pins to the composer's 16px text column) and one
     --text-sm (13px rung) for both name and meta (name keeps weight 500 +
     full ink, meta keeps muted ink — size never differs). */
  padding: var(--menu-row-padding-block) var(--space-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  border-radius: var(--radius-menu-row);
}

.mention-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: var(--muted);
  flex-shrink: 0;
}

/* Pin every glyph to the same box so rows line up regardless of icon kind. */
.mention-icon :deep(svg) {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
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
/* Stale rows: candidates from the previous query, kept visible (dimmed)
   while the new search is pending so the menu never flashes empty. */
.mention-item {
  /* Slow the stale fade way down (260ms): a fast whole-menu dim reads as a
     jarring flash when it is really just the re-search settling. */
  transition: opacity var(--duration-slow) var(--ease-out);
}
.mention-item.stale {
  opacity: var(--opacity-stale);
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
  /* Hug the content: the name → meta gap is the row's fixed flex gap, not a
     column position (the old 80px min-width made it vary with name length). */
  flex-shrink: 0;
}

.mention-meta {
  color: var(--color-text-muted);
  /* Same size as the name (13px) — only ink and weight differ. */
  font-size: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
