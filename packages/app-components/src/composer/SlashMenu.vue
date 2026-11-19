<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { matchRanges, type SlashCommand, type SlashMatchRanges } from '@moonshot-ai/app-core/lib';
import { ensurePointerTracking, isSyntheticPointerMove } from '@moonshot-ai/app-ui';
import { mentionIconSvg } from '@moonshot-ai/app-composer/features/mention';
import ComposerMenuHints from './ComposerMenuHints.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  items: SlashCommand[];
  activeIndex: number;
  query?: string;
  ranges?: SlashMatchRanges[];
  layout?: 'popup' | 'sheet';
}>(), {
  query: '',
  layout: 'popup',
});

const emit = defineEmits<{
  select: [item: SlashCommand];
  hover: [index: number];
}>();

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

const skillIcon = mentionIconSvg('skill', '', '');

function onMenuMouseDown(event: MouseEvent): void {
  if (props.layout === 'popup') event.preventDefault();
}

function descText(item: SlashCommand): string {
  return item.isSkill ? item.desc : t(item.desc);
}

const segmented = computed(() =>
  props.items.map((item, i) => {
    const desc = descText(item);
    const ranges = props.ranges?.[i] ?? matchRanges(props.query, item.name, desc);
    return {
      item,
      namePieces: pieces(item.name, ranges.name),
      desc,
      descPieces: pieces(desc, ranges.desc),
      dir: item.workspaceLabel ?? (item.sourceKind === undefined ? undefined : t(`mention.${item.sourceKind}`)),
      showCommandsHeader: item.isSkill !== true && i === 0,
      showSkillsHeader: item.isSkill === true && (i === 0 || props.items[i - 1]?.isSkill !== true),
    };
  }),
);

const scrollEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
defineExpose({ el: menuEl });
const scrolledUp = ref(false);
const canScrollDown = ref(false);
let resizeObserver: ResizeObserver | null = null;

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

function onRowPointerMove(event: PointerEvent, index: number): void {
  if (isSyntheticPointerMove(event)) return;
  emit('hover', index);
}

let activeThumbCleanup: (() => void) | null = null;

function onThumbPointerDown(event: PointerEvent): void {
  const el = scrollEl.value;
  const current = thumb.value;
  if (!el || !current) return;
  event.preventDefault();
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
  window.addEventListener('pointercancel', onUp);
}

const maskImage = computed(() => {
  const up = scrolledUp.value;
  const down = canScrollDown.value;
  const fade = 'var(--menu-scroll-fade)';
  if (up && down) return `linear-gradient(to bottom, transparent 0, black ${fade}, black calc(100% - ${fade}), transparent 100%)`;
  if (up) return `linear-gradient(to bottom, transparent, black ${fade})`;
  if (down) return `linear-gradient(to top, transparent, black ${fade})`;
  return undefined;
});

const scrollMaxHeight = ref('');

function clampScrollToViewport(): void {
  const menu = menuEl.value;
  const scroll = scrollEl.value;
  const parent = menu?.offsetParent as HTMLElement | null;
  if (!menu || !scroll || !parent) return;
  const menuStyle = getComputedStyle(menu);
  const gap = parseFloat(menuStyle.getPropertyValue('--space-2')) || 8;
  const margin = parseFloat(menuStyle.getPropertyValue('--space-2')) || 8;
  const hints = menu.querySelector<HTMLElement>('.composer-menu-hints');
  const hintsHeight = hints ? hints.offsetHeight + (parseFloat(getComputedStyle(hints).marginTop) || 0) : 0;
  const chrome = (parseFloat(menuStyle.paddingTop) || 0) + (parseFloat(menuStyle.paddingBottom) || 0) + hintsHeight;
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
  ensurePointerTracking();
  if (props.layout === 'sheet') {
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
        if (entry.target === scrollEl.value) updateScrollState();
        else clampScrollToViewport();
      }
    });
    resizeObserver.observe(scrollEl.value);
    const parent = menuEl.value?.offsetParent;
    if (parent) resizeObserver.observe(parent);
  }
  window.addEventListener('resize', clampScrollToViewport);
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
  <div ref="menuEl" class="slash-menu" :class="{ 'is-sheet': layout === 'sheet' }" data-menu-frame @mousedown="onMenuMouseDown">
    <div v-if="items.length === 0" class="slash-empty" role="status">{{ t('composer.noCommands') }}</div>
    <div id="composer-slash-menu" v-show="items.length > 0" ref="scrollEl" class="slash-scroll" role="listbox" :style="{ maskImage, maxHeight: scrollMaxHeight }" @scroll="onScroll">
      <template v-for="(entry, i) in segmented" :key="`${entry.item.name}-${i}`">
        <div v-if="entry.showCommandsHeader" class="slash-section-label" role="presentation">{{ t('composer.slashCommandsGroup') }}</div>
        <div v-if="entry.showSkillsHeader" class="slash-section-label" :class="{ 'after-section': i > 0 }" role="presentation">{{ t('mention.skills') }}</div>
        <div
          :id="`composer-slash-option-${i}`"
          class="slash-item"
          :class="{ active: i === props.activeIndex, 'is-skill': entry.item.isSkill === true }"
          role="option"
          :aria-selected="i === props.activeIndex"
          @pointermove="onRowPointerMove($event, i)"
          @mousedown.prevent="emit('select', entry.item)"
        >
          <span v-if="entry.item.isSkill === true" class="slash-icon" aria-hidden="true" v-html="skillIcon" />
          <span class="slash-name"><template v-for="(piece, pi) in entry.namePieces" :key="pi"><span v-if="piece.hit" class="slash-match">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></span>
          <span class="slash-desc"><template v-for="(piece, pi) in entry.descPieces" :key="pi"><span v-if="piece.hit" class="slash-desc-match">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></span>
          <span v-if="entry.dir" class="slash-dir">{{ entry.dir }}</span>
        </div>
      </template>
    </div>
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
    <ComposerMenuHints v-if="layout === 'popup' && items.length > 0" />
  </div>
</template>

<style scoped>
.slash-menu[data-menu-frame] {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  padding: var(--space-1-5) var(--space-3);
  background: var(--color-menu-bg-frost);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  z-index: var(--z-dropdown);
}

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
.slash-menu.is-sheet .slash-scroll {
  margin: 0;
  padding: var(--space-1) var(--space-2);
}
.slash-menu.is-sheet .slash-item {
  margin: 0;
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}

.slash-scroll {
  max-height: var(--p-slash-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
}
.slash-scroll::-webkit-scrollbar { display: none; }
.scroll-thumb {
  position: absolute;
  right: var(--menu-scrollbar-edge);
  width: var(--menu-scrollbar-width);
  border-radius: var(--radius-full);
  background: var(--color-menu-scrollbar);
  transition: background var(--duration-base) var(--ease-out);
  cursor: default;
  touch-action: none;
  z-index: var(--z-raised);
}
.slash-menu:hover .scroll-thumb {
  background: var(--color-menu-scrollbar-hover);
}
.scroll-thumb::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--space-2));
  right: 0;
}

.slash-section-label {
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--space-1) var(--space-2) var(--space-05);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}

.slash-section-label.after-section {
  margin-top: var(--space-2);
}

.slash-icon {
  display: inline-flex;
  align-self: center;
  flex: none;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: var(--muted);
}
.slash-icon :deep(svg) {
  display: block;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
}
.slash-item:hover .slash-icon,
.slash-item.active .slash-icon {
  color: var(--color-text-strong);
}

.slash-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
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

.slash-empty {
  padding: var(--space-1-5) var(--space-1);
  color: var(--color-text-muted);
}

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

.slash-dir {
  flex: none;
  margin-left: auto;
  max-width: 12rem;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 520px) {
  .slash-item:not(.is-skill) {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-05);
  }
  .slash-item:not(.is-skill) .slash-name {
    max-width: none;
  }
  .slash-item.is-skill .slash-name {
    max-width: 45%;
  }
}
</style>
