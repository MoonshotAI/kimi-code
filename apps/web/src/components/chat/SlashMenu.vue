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
  /** 'popup' = the absolute frame floating above the composer (desktop and
      wide viewports). 'sheet' = a static list body living inside the mobile
      BottomSheet — no absolute positioning and no viewport clamp (the sheet
      owns the frame, the surface and the height budget). */
  layout?: 'popup' | 'sheet';
}>(), {
  query: '',
  layout: 'popup',
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
const menuEl = ref<HTMLElement | null>(null);
// Expose the root element so the composer can register the popup as a menu
// surface (trackMenuSurface) while it is open.
defineExpose({ el: menuEl });
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
  const cap = parseFloat(getComputedStyle(scroll).getPropertyValue('--p-slash-menu-h')) || Number.POSITIVE_INFINITY;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const available = parent.getBoundingClientRect().top - viewportTop - gap - margin - chrome;
  scrollMaxHeight.value = `${Math.max(Math.floor(Math.min(cap, available)), 0)}px`;
  void nextTick(() => {
    updateScrollState();
    scrollActiveIntoView();
  });
}

onMounted(() => {
  if (props.layout === 'sheet') {
    // Sheet layout: the BottomSheet owns the frame and the height budget —
    // the scrollport keeps its token cap, nothing to clamp.
    updateScrollState();
    if (typeof ResizeObserver === 'function' && scrollEl.value) {
      resizeObserver = new ResizeObserver(() => updateScrollState());
      resizeObserver.observe(scrollEl.value);
    }
    return;
  }
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
  <div ref="menuEl" class="slash-menu" :class="{ 'is-sheet': layout === 'sheet' }" data-menu-frame>
    <!-- Zero results is a live status note, not a listbox item. -->
    <div v-if="items.length === 0" class="slash-empty" role="status">{{ t('composer.noCommands') }}</div>
    <div id="composer-slash-menu" v-show="items.length > 0" ref="scrollEl" class="slash-scroll" role="listbox" :style="{ maskImage, maxHeight: scrollMaxHeight }" @scroll="onScroll">
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
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  z-index: var(--z-dropdown);
}

/* Sheet layout: the BottomSheet owns the surface — the list is a static body
   with no frame, no absolute positioning, no viewport clamp. */
.slash-menu.is-sheet[data-menu-frame] {
  position: static;
  padding: 0;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
  z-index: auto;
}
/* Sheet mode scrollport: drop the popup's negative-margin outreach (it would
   bleed 6px past the sheet's edges); rows hug a plain 8px inset instead. */
.slash-menu.is-sheet .slash-scroll {
  margin: 0;
  padding: var(--space-1) var(--space-2);
}
/* Sheet rows: no −hug outreach — caps sit 8px from the sheet's edges
   (symmetric) and the content lands on the 16px column shared with the
   sheet's title and search box. */
.slash-menu.is-sheet .slash-item {
  margin: 0;
  padding-left: var(--space-2);
  padding-right: var(--space-2);
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
     composer's 16px text column; --radius-menu-row keeps the row caps
     concentric with the 12px menu frame (12px − 6px hug). */
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--menu-row-padding-block) var(--menu-row-padding-inline);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
  border-radius: var(--radius-menu-row);
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
