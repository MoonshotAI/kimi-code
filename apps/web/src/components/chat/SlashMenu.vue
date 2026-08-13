<!-- apps/web/src/components/chat/SlashMenu.vue -->
<!-- Popup list of slash commands shown above the Composer textarea. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { matchRanges, type SlashCommand, type SlashMatchRanges } from '@moonshot-ai/app-core/lib';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  items: SlashCommand[];
  activeIndex: number;
  /** The token after `/` — the matching fragment inside each command name. */
  query?: string;
  /** Fuse's actual match ranges per item (aligned with `items`); rows fall
      back to local computation when absent. */
  ranges?: SlashMatchRanges[];
}>(), {
  query: '',
});

const emit = defineEmits<{
  select: [item: SlashCommand];
  hover: [index: number];
}>();

/** Split a string into plain/highlighted pieces around matchRanges ranges —
    every fragment of a fuzzy hit renders bold, not just the first. */
function pieces(text: string, ranges?: [number, number][]): { text: string; hit: boolean }[] {
  if (!ranges || ranges.length === 0) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** Display description for an item (built-ins carry i18n keys). */
function descText(item: SlashCommand): string {
  return item.isSkill ? item.desc : t(item.desc);
}

const segmented = computed(() =>
  props.items.map((item, i) => {
    const desc = descText(item);
    const ranges = props.ranges?.[i] ?? matchRanges(props.query, item.name, desc);
    return { item, namePieces: pieces(item.name, ranges.name), desc, descPieces: pieces(desc, ranges.desc) };
  }),
);

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
// reset to row 0 after each re-filter) must pull off-screen rows back into
// view. Manual scrollTop math — scrollIntoView would also scroll ancestor
// scrollers (the conversation behind the menu).
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
  <div class="slash-menu" data-menu-frame>
    <!-- Zero results is a live status note, not a listbox item. -->
    <div v-if="items.length === 0" class="slash-empty" role="status">{{ t('composer.noCommands') }}</div>
    <div id="composer-slash-menu" v-show="items.length > 0" ref="scrollEl" class="slash-scroll" role="listbox" :style="{ maskImage }" @scroll="onScroll">
      <div
        v-for="(entry, i) in segmented"
        :key="`${entry.item.name}-${i}`"
        :id="`composer-slash-option-${i}`"
        class="slash-item"
        :class="{ active: i === props.activeIndex }"
        role="option"
        :aria-selected="i === props.activeIndex"
        @mouseenter="emit('hover', i)"
        @mousedown.prevent="emit('select', entry.item)"
      >
        <span class="slash-name"><template v-for="(piece, pi) in entry.namePieces" :key="pi"><span v-if="piece.hit" class="slash-match">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></span>
        <span class="slash-desc"><template v-for="(piece, pi) in entry.descPieces" :key="pi"><span v-if="piece.hit" class="slash-desc-match">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></span>
      </div>
    </div>
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
  </div>
</template>

<style scoped>
/* `[data-menu-frame]` keeps the attribute-level specificity (the
   listbox role — and the combobox's controlled id — now live on the inner
   scroll container). Chrome shared with the add menu:
   the dock panel's frosted material and the composer card's corner geometry.
   No overflow clip on the frame — the scroll container below clips rows
   exactly at their own edge, and their corner-shaped caps sit ~4px inside
   the frame's corner curve on their own. */
.slash-menu[data-menu-frame] {
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
.slash-scroll {
  max-height: var(--p-slash-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
}
.slash-scroll::-webkit-scrollbar { display: none; }
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
.slash-menu:hover .scroll-thumb {
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

.slash-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  /* Box hugs 6px from the menu edge while the command text lands on the
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

.slash-item:hover {
  background: var(--color-hover);
}
.slash-item.active {
  background: var(--color-selected);
}

/* The declared seam between stacked rows, so adjacent hover/selected
   backgrounds don't stick together. */
.slash-item + .slash-item {
  margin-top: var(--menu-rows-seam);
}

.slash-name {
  flex: none;
  max-width: 60%;
  color: var(--color-text);
  font-weight: 500;
  min-width: 0;
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.slash-match {
  font-weight: var(--weight-semibold);
}

/* Same 16px text column as the rows (scroll container's content box starts
   at 12px). */
.slash-empty {
  padding: var(--space-1-5) var(--space-1);
  color: var(--color-text-muted);
}

/* Touch: menu rows meet the 44px minimum hit height — a direct min-height,
   since fixed padding alone falls short at the Small font size. */
@media (hover: none) {
  .slash-item {
    min-height: var(--touch-target-min);
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}

.slash-desc {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--ui-b2);
  font-weight: var(--weight-regular);
  line-height: var(--leading-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slash-desc-match {
  font-weight: var(--weight-semibold);
}

@media (max-width: 520px) {
  .slash-item {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-05);
  }
  .slash-name {
    max-width: none;
  }
}
</style>
