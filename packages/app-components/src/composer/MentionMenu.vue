<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ensurePointerTracking, isSyntheticPointerMove } from '@moonshot-ai/app-ui';
import { attachmentKindIconSvg } from '@moonshot-ai/app-composer/features/attachment';
import { fileMentionIconSvg, mentionIconSvg, mentionMatchSpans, type MentionMatchSpan } from '@moonshot-ai/app-composer/features/mention';
import type { MentionItem } from '@moonshot-ai/app-client/composables';
import { iconSvg } from '@moonshot-ai/app-client/icons';
import type { FileItem } from '@moonshot-ai/app-core/client/types';
import { skillDirectoryName, skillIdentity, skillSourceKind } from '@moonshot-ai/app-core/lib';
import AuthMedia from '../chat/AuthMedia.vue';
import VideoRailPreview from '../chat/VideoRailPreview.vue';
import ComposerMenuHints from './ComposerMenuHints.vue';

export type { FileItem };

const props = withDefaults(defineProps<{
  items: MentionItem[];
  activeIndex: number;
  loading: boolean;
  query?: string;
  layout?: 'popup' | 'sheet';
}>(), { query: '', layout: 'popup' });

const emit = defineEmits<{
  select: [item: MentionItem];
  hover: [index: number];
}>();

const { t } = useI18n();

function rowKey(item: MentionItem): string {
  if (item.kind === 'browser') return `browser:${item.browser.captureId}`;
  if (item.kind === 'attachment') return `attachment:${item.attachment.entry.attId}`;
  return item.kind === 'skill' ? `skill:${skillIdentity(item.skill)}` : item.file.path;
}

function rowSection(item: MentionItem): 'media' | 'file' | 'skill' | 'browser' {
  if (item.kind === 'browser') return 'browser';
  if (item.kind === 'attachment') {
    return item.attachment.entry.kind === 'image' || item.attachment.entry.kind === 'video'
      ? 'media'
      : 'file';
  }
  if (item.kind === 'skill') return 'skill';
  return 'file';
}

function sectionLabel(item: MentionItem): string {
  if (item.kind === 'browser') return t('browserReference.group');
  if (rowSection(item) === 'media') return t('composer.imagesAndVideos');
  if (item.kind === 'skill') return t('mention.skills');
  return t('composer.addFiles');
}

const searchingLabel = computed(() =>
  props.query === '' ? t('mention.searching') : t('mention.searchingFor', { query: props.query }),
);

const searchingNeedsHeader = computed(() => {
  const last = props.items.at(-1);
  return last === undefined || rowSection(last) !== 'file';
});

function onMenuMouseDown(event: MouseEvent): void {
  if (props.layout === 'popup') event.preventDefault();
}

function rowIcon(item: MentionItem): string {
  if (item.kind === 'browser') return iconSvg('browser', 'sm');
  if (item.kind === 'attachment') return attachmentKindIconSvg(item.attachment.entry.kind);
  if (item.kind === 'skill') return mentionIconSvg('skill', '', item.skill.name);
  return fileMentionIconSvg(item.file.path, item.file.name, item.kind === 'folder');
}

function rowDir(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

function skillSpans(item: Extract<MentionItem, { kind: 'skill' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.skill.name, item.matchPositions, 0);
}

function skillWorkspaceLabel(item: Extract<MentionItem, { kind: 'skill' }>): string | undefined {
  const workspace = skillDirectoryName(item.skill.workspaceDir);
  if (workspace !== undefined) return workspace;
  const source = skillSourceKind(item.skill.source);
  return source === undefined ? undefined : t(`mention.${source}`);
}

function attachmentLabelSpans(item: Extract<MentionItem, { kind: 'attachment' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.attachment.label, item.labelMatchPositions ?? [], 0);
}

function attachmentNameSpans(item: Extract<MentionItem, { kind: 'attachment' }>): MentionMatchSpan[] {
  return mentionMatchSpans(item.attachment.entry.name, item.nameMatchPositions ?? [], 0);
}

function attachmentHasPreview(item: Extract<MentionItem, { kind: 'attachment' }>): boolean {
  const entry = item.attachment.entry;
  return (entry.kind === 'image' || entry.kind === 'video') &&
    (entry.thumbnailUrl !== undefined || entry.previewUrl !== undefined || entry.fileId !== undefined);
}

function attachmentUsesLocalPreview(item: Extract<MentionItem, { kind: 'attachment' }>): boolean {
  const url = item.attachment.entry.previewUrl;
  return url?.startsWith('blob:') === true || url?.startsWith('data:') === true;
}

function nameSpans(file: FileItem): MentionMatchSpan[] {
  const path = file.path.endsWith('/') ? file.path.slice(0, -1) : file.path;
  return mentionMatchSpans(file.name, file.matchPositions, Math.max(0, path.length - file.name.length));
}

function dirSpans(file: FileItem): MentionMatchSpan[] {
  return mentionMatchSpans(rowDir(file.path), file.matchPositions, 0);
}

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
  () => [props.items, props.loading],
  () => {
    void nextTick(() => {
      updateScrollState();
      scrollActiveIntoView();
    });
  },
);
</script>

<template>
  <div ref="menuEl" class="mention-menu" :class="{ 'is-sheet': layout === 'sheet' }" data-menu-frame @mousedown="onMenuMouseDown">
    <div v-if="!props.loading && props.items.length === 0" class="mention-state dim" role="status">{{ t('mention.noMatch') }}</div>
    <div
      id="composer-mention-menu"
      v-show="props.items.length > 0 || props.loading"
      ref="scrollEl"
      class="mention-scroll"
      role="listbox"
      :style="{ maskImage, maxHeight: scrollMaxHeight }"
      @scroll="onScroll"
    >
      <template v-for="(row, i) in props.items" :key="rowKey(row)">
        <div
          v-if="i === 0 || rowSection(row) !== rowSection(props.items[i - 1]!)"
          class="mention-section-label"
          :class="{ 'after-section': i > 0 }"
          role="presentation"
        >
          {{ sectionLabel(row) }}
        </div>
        <div
          :id="`composer-mention-option-${i}`"
          class="mention-item"
          :class="{ active: i === props.activeIndex }"
          role="option"
          :aria-selected="i === props.activeIndex"
          @pointermove="onRowPointerMove($event, i)"
          @mousedown.prevent="emit('select', row)"
        >
          <template v-if="row.kind === 'browser'">
            <span class="mention-attachment-thumb" aria-hidden="true">
              <img v-if="row.browser.thumbnail" class="mention-attachment-media" :src="row.browser.thumbnail" alt="" />
              <span v-else class="mention-attachment-icon" v-html="rowIcon(row)" />
            </span>
            <span class="mention-browser-text">
              <span class="mention-name">{{ row.browser.label }}</span>
              <span class="mention-meta">{{ row.browser.title }} · {{ row.browser.url }}</span>
            </span>
          </template>
          <template v-else-if="row.kind === 'attachment'">
            <span class="mention-attachment-thumb" aria-hidden="true">
              <img
                v-if="row.attachment.entry.thumbnailUrl"
                class="mention-attachment-media"
                :src="row.attachment.entry.thumbnailUrl"
                alt=""
              />
              <VideoRailPreview
                v-else-if="row.attachment.entry.kind === 'video' && row.attachment.entry.fileId && !attachmentUsesLocalPreview(row)"
                :file-id="row.attachment.entry.fileId"
                :session-id="row.attachment.entry.sessionId"
                class="mention-attachment-media"
              />
              <AuthMedia
                v-else-if="attachmentHasPreview(row) && (row.attachment.entry.kind !== 'video' || attachmentUsesLocalPreview(row))"
                :url="row.attachment.entry.previewUrl ?? ''"
                :kind="row.attachment.entry.kind === 'video' ? 'video' : 'image'"
                :file-id="attachmentUsesLocalPreview(row) ? undefined : row.attachment.entry.fileId"
                :session-id="attachmentUsesLocalPreview(row) ? undefined : row.attachment.entry.sessionId"
                media-class="mention-attachment-media"
                :controls="false"
                muted
              />
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span v-else class="mention-icon mention-attachment-icon" v-html="rowIcon(row)" />
            </span>
            <span class="mention-name"><template v-for="(span, k) in attachmentLabelSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span v-if="row.attachment.entry.name !== row.attachment.label" class="mention-meta"><template v-for="(span, k) in attachmentNameSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
          </template>
          <template v-else-if="row.kind === 'skill'">
            <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
            <span class="mention-name"><template v-for="(span, k) in skillSpans(row)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span class="mention-meta">{{ row.skill.description }}</span>
            <span v-if="skillWorkspaceLabel(row)" class="mention-dir">{{ skillWorkspaceLabel(row) }}</span>
          </template>
          <template v-else>
            <span class="mention-icon" v-html="rowIcon(row)" aria-hidden="true" />
            <span class="mention-name"><template v-for="(span, k) in nameSpans(row.file)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
            <span v-if="rowDir(row.file.path)" class="mention-meta"><template v-for="(span, k) in dirSpans(row.file)" :key="k"><span v-if="span.hit" class="mention-hit">{{ span.text }}</span><template v-else>{{ span.text }}</template></template></span>
          </template>
        </div>
      </template>
      <template v-if="props.loading">
        <div
          v-if="searchingNeedsHeader"
          class="mention-section-label"
          :class="{ 'after-section': props.items.length > 0 }"
          role="presentation"
        >
          {{ t('composer.addFiles') }}
        </div>
        <div class="mention-searching dim" role="status">{{ searchingLabel }}</div>
      </template>
    </div>
    <!-- Overlay scroll indicator (the native bar is hidden — it ate row width) -->
    <div v-if="thumb && props.items.length > 0" class="scroll-thumb" @pointerdown="onThumbPointerDown" :style="{ top: `${thumb.top}px`, height: `${thumb.height}px` }" />
    <ComposerMenuHints v-if="layout === 'popup' && props.items.length > 0" />
  </div>
</template>

<style scoped>
.mention-menu[data-menu-frame] {
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

.mention-menu.is-sheet[data-menu-frame] {
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
.mention-menu.is-sheet .mention-scroll {
  margin: 0;
  padding: var(--space-1) var(--space-2);
}
.mention-menu.is-sheet .mention-item {
  margin: 0;
  padding-left: var(--space-2);
  padding-right: var(--space-2);
}
.mention-menu.is-sheet .mention-section-label {
  margin-left: 0;
  margin-right: 0;
}
.mention-menu.is-sheet .mention-state {
  padding-left: var(--space-4);
}

.mention-scroll {
  max-height: var(--p-mention-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
}
.mention-scroll::-webkit-scrollbar { display: none; }
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
.mention-menu:hover .scroll-thumb {
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

.mention-state {
  padding: var(--space-2) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
}

.mention-section-label {
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: var(--space-1) var(--space-2) var(--space-05);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}
.mention-section-label.after-section {
  margin-top: var(--space-2);
}

.mention-searching {
  padding: var(--menu-row-padding-block) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

.dim {
  color: var(--color-text-muted);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  margin: 0 calc(-1 * var(--menu-row-hug));
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

.mention-icon :deep(svg) {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  display: block;
}

.mention-attachment-thumb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-button-sm);
  height: var(--icon-button-sm);
  overflow: hidden;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xs);
  background: var(--color-well);
  color: var(--muted);
  flex-shrink: 0;
}

.mention-attachment-thumb :deep(.mention-attachment-media) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mention-attachment-icon {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
}

.mention-attachment-icon :deep(svg) {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
}

.mention-item:hover .mention-icon,
.mention-item.active .mention-icon {
  color: var(--color-text-strong);
}

.mention-item:hover {
  background: var(--color-hover);
}
.mention-name {
  color: var(--color-text-strong);
}
.mention-item.active {
  background: var(--color-selected);
}

.mention-item + .mention-item {
  margin-top: var(--menu-rows-seam);
}
@media (hover: none) {
  .mention-item {
    min-height: var(--touch-target-min);
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}

.mention-browser-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-05);
}
.mention-browser-text > .mention-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mention-name {
  color: var(--color-text);
  font-weight: 500;
  flex-shrink: 0;
}

.mention-name .mention-hit {
  color: var(--color-text-strong);
  font-weight: var(--weight-semibold);
}

.mention-meta .mention-hit {
  color: var(--color-text);
}

.mention-meta {
  color: var(--color-text-muted);
  font-size: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-dir {
  flex: none;
  margin-left: auto;
  max-width: 12rem;
  overflow: hidden;
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
