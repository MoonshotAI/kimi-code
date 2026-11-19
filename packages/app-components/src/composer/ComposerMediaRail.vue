<script setup lang="ts">
import {
  attachmentReferenceName,
  type AttachmentEntry,
} from '@moonshot-ai/app-composer/features/attachment';
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import MediaThumb from '../chat/MediaThumb.vue';
import {
  clampMediaDragTranslate,
  mediaDropIndicatorCenter,
  mediaKeyboardReorderTarget,
  mediaPointerIntent,
} from './mediaRailDrag';

const props = defineProps<{
  entries: readonly AttachmentEntry[];
}>();

const emit = defineEmits<{
  activate: [entry: AttachmentEntry, img: HTMLImageElement | null];
  mention: [entry: AttachmentEntry];
  remove: [attId: string];
  reorder: [attId: string, to: number];
}>();

const { t } = useI18n();
const railRef = ref<HTMLElement | null>(null);
const draggingId = ref<string | null>(null);
const dropIndex = ref<number | null>(null);
const indicatorLeft = ref<number | null>(null);
const dragTranslateX = ref(0);
let pendingDrag: {
  attId: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  startScrollLeft: number;
  element: HTMLElement;
  longPressTimer: number | null;
  touchScrolling: boolean;
} | null = null;
let suppressClickAttId: string | null = null;
let autoScrollDirection = 0;
let autoScrollFrame = 0;
let lastPointerX = 0;

function mediaElements(): HTMLElement[] {
  return Array.from(
    railRef.value?.querySelectorAll<HTMLElement>('[data-media-att-id]') ?? [],
  );
}

function stopAutoScroll(): void {
  autoScrollDirection = 0;
  if (autoScrollFrame !== 0) window.cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = 0;
}

function updateDragTranslate(clientX: number): void {
  const rail = railRef.value;
  const pending = pendingDrag;
  const elements = mediaElements();
  const first = elements[0];
  const last = elements.at(-1);
  if (rail === null || pending === null || first === undefined || last === undefined) return;
  dragTranslateX.value = clampMediaDragTranslate({
    translate: clientX - pending.startX + rail.scrollLeft - pending.startScrollLeft,
    draggedStart: pending.element.offsetLeft,
    draggedSize: pending.element.offsetWidth,
    contentStart: first.offsetLeft,
    contentEnd: last.offsetLeft + last.offsetWidth,
  });
}

function updateDropPosition(clientX: number): void {
  const rail = railRef.value;
  const attId = draggingId.value;
  if (rail === null || attId === null) return;
  const candidates = mediaElements().filter((element) => element.dataset.mediaAttId !== attId);
  const railRect = rail.getBoundingClientRect();
  const contentX = clientX - railRect.left + rail.scrollLeft;
  const to = candidates.findIndex((element) => contentX < element.offsetLeft + element.offsetWidth / 2);
  const index = to === -1 ? candidates.length : to;
  dropIndex.value = index;
  indicatorLeft.value = mediaDropIndicatorCenter({
    targetIndex: index,
    contentStart: rail.clientLeft,
    slots: mediaElements().map((element) => ({
      start: element.offsetLeft,
      size: element.offsetWidth,
    })),
  });
}

function runAutoScroll(): void {
  autoScrollFrame = 0;
  const rail = railRef.value;
  if (rail === null || draggingId.value === null || autoScrollDirection === 0) return;
  rail.scrollLeft += autoScrollDirection * 8;
  updateDragTranslate(lastPointerX);
  updateDropPosition(lastPointerX);
  autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
}

function updateAutoScroll(clientX: number): void {
  const rail = railRef.value;
  if (rail === null) return;
  const rect = rail.getBoundingClientRect();
  const direction = clientX < rect.left + 32 ? -1 : clientX > rect.right - 32 ? 1 : 0;
  if (direction === autoScrollDirection) return;
  stopAutoScroll();
  autoScrollDirection = direction;
  if (direction !== 0) autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
}

function activatePendingDrag(): void {
  const pending = pendingDrag;
  if (pending === null) return;
  if (pending.longPressTimer !== null) window.clearTimeout(pending.longPressTimer);
  pending.longPressTimer = null;
  draggingId.value = pending.attId;
  dropIndex.value = props.entries.findIndex((entry) => entry.attId === pending.attId);
  lastPointerX = pending.startX;
  pending.element.querySelector<HTMLButtonElement>('.media-thumb-btn')?.blur();
  pending.element.setPointerCapture?.(pending.pointerId);
  updateDropPosition(pending.startX);
}

function clearPendingDrag(): void {
  if (pendingDrag?.longPressTimer !== null && pendingDrag?.longPressTimer !== undefined) {
    window.clearTimeout(pendingDrag.longPressTimer);
  }
  pendingDrag = null;
  window.removeEventListener('pointermove', onWindowPointerMove);
  window.removeEventListener('pointerup', onWindowPointerUp);
  window.removeEventListener('pointercancel', onWindowPointerCancel);
  window.removeEventListener('keydown', onWindowKeydown);
}

function suppressNextClick(attId: string): void {
  suppressClickAttId = attId;
  window.setTimeout(() => {
    if (suppressClickAttId === attId) suppressClickAttId = null;
  });
}

function finishDrag(commit: boolean): void {
  const attId = draggingId.value;
  const to = dropIndex.value;
  if (attId !== null && commit && to !== null) emit('reorder', attId, to);
  if (attId !== null) suppressNextClick(attId);
  draggingId.value = null;
  dropIndex.value = null;
  indicatorLeft.value = null;
  dragTranslateX.value = 0;
  stopAutoScroll();
  clearPendingDrag();
}

function onWindowPointerMove(event: PointerEvent): void {
  const pending = pendingDrag;
  if (pending === null || event.pointerId !== pending.pointerId) return;
  if (draggingId.value === null) {
    const deltaX = event.clientX - pending.startX;
    const deltaY = event.clientY - pending.startY;
    const intent = mediaPointerIntent({
      pointerType: pending.pointerType,
      deltaX,
      deltaY,
    });
    if (pending.pointerType === 'touch') {
      if (pending.touchScrolling || intent === 'scroll') {
        if (pending.longPressTimer !== null) window.clearTimeout(pending.longPressTimer);
        pending.longPressTimer = null;
        pending.touchScrolling = true;
        event.preventDefault();
        if (railRef.value !== null) railRef.value.scrollLeft = pending.startScrollLeft - deltaX;
      } else if (intent === 'cancel') {
        clearPendingDrag();
      }
      return;
    }
    if (intent !== 'drag') return;
    activatePendingDrag();
  }
  if (draggingId.value === null) return;
  event.preventDefault();
  lastPointerX = event.clientX;
  updateDragTranslate(event.clientX);
  updateDropPosition(event.clientX);
  updateAutoScroll(event.clientX);
}

function onWindowPointerUp(event: PointerEvent): void {
  if (event.pointerId !== pendingDrag?.pointerId) return;
  if (pendingDrag.touchScrolling) {
    suppressNextClick(pendingDrag.attId);
    clearPendingDrag();
    return;
  }
  const rect = railRef.value?.getBoundingClientRect();
  const validDrop = rect !== undefined &&
    event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  finishDrag(draggingId.value !== null && validDrop);
}

function onWindowPointerCancel(event: PointerEvent): void {
  if (event.pointerId !== pendingDrag?.pointerId) return;
  finishDrag(false);
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || pendingDrag === null) return;
  event.preventDefault();
  finishDrag(false);
}

function onThumbPointerDown(entry: AttachmentEntry, event: PointerEvent): void {
  if (!event.isPrimary || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target === null || target.closest('.media-thumb-tool') !== null) return;
  if (target.closest('.media-thumb-btn') === null) return;
  clearPendingDrag();
  const element = event.currentTarget as HTMLElement;
  pendingDrag = {
    attId: entry.attId,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    startX: event.clientX,
    startY: event.clientY,
    startScrollLeft: railRef.value?.scrollLeft ?? 0,
    element,
    longPressTimer: event.pointerType === 'touch'
      ? window.setTimeout(activatePendingDrag, 300)
      : null,
    touchScrolling: false,
  };
  window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerCancel);
  window.addEventListener('keydown', onWindowKeydown);
}

function onThumbClickCapture(entry: AttachmentEntry, event: MouseEvent): void {
  if (suppressClickAttId !== entry.attId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onThumbKeydown(entry: AttachmentEntry, index: number, event: KeyboardEvent): void {
  if ((event.target as HTMLElement | null)?.closest('.media-thumb-btn') === null) return;
  const to = mediaKeyboardReorderTarget({
    index,
    length: props.entries.length,
    altKey: event.altKey,
    key: event.key,
    preventDefault: () => event.preventDefault(),
  });
  if (to === null) return;
  emit('reorder', entry.attId, to);
}

function thumbTransform(entry: AttachmentEntry, index: number): string | undefined {
  const attId = draggingId.value;
  const to = dropIndex.value;
  if (attId === null || to === null) return undefined;
  const from = props.entries.findIndex((candidate) => candidate.attId === attId);
  if (entry.attId === attId) return `translateX(${dragTranslateX.value}px)`;
  if (from < to && index > from && index <= to) {
    return 'translateX(calc((var(--p-composer-media-thumb) + var(--space-2)) * -1))';
  }
  if (from > to && index >= to && index < from) {
    return 'translateX(calc(var(--p-composer-media-thumb) + var(--space-2)))';
  }
  return undefined;
}

function referenceName(entry: AttachmentEntry): string {
  return attachmentReferenceName(entry, {
    image: t('composer.attachmentImage'),
    video: t('composer.attachmentVideo'),
  });
}

watch(
  () => props.entries.length,
  (length, previous) => {
    if (length <= previous) return;
    void nextTick(() => {
      const rail = railRef.value;
      if (rail !== null) rail.scrollLeft = rail.scrollWidth;
    });
  },
);

onUnmounted(() => finishDrag(false));
</script>

<template>
  <div ref="railRef" class="composer-media-rail" role="list" :aria-label="t('composer.mediaAttachments')" @dragstart.prevent>
    <span
      v-if="indicatorLeft !== null && draggingId !== null"
      class="composer-media-drop-indicator"
      :style="{ left: `${indicatorLeft}px` }"
      aria-hidden="true"
    />
    <MediaThumb
      v-for="(entry, index) in entries"
      :key="entry.attId"
      :data-media-att-id="entry.attId"
      :style="{ transform: thumbTransform(entry, index) }"
      role="listitem"
      size="composer"
      :kind="entry.kind === 'video' ? 'video' : 'image'"
      :name="entry.name"
      :url="entry.previewUrl"
      :thumbnail-url="entry.thumbnailUrl"
      :file-id="entry.fileId"
      :session-id="entry.sessionId"
      :uploading="entry.uploading"
      :error="entry.error !== undefined"
      :ordinal="entry.mediaOrdinal"
      reorderable
      :dragging="draggingId === entry.attId"
      mentionable
      :mention-label="t('composer.mentionNamed', { name: referenceName(entry) })"
      removable
      :remove-label="t('composer.removeNamed', { name: referenceName(entry) })"
      @activate="emit('activate', entry, $event)"
      @mention="emit('mention', entry)"
      @remove="emit('remove', entry.attId)"
      @pointerdown="onThumbPointerDown(entry, $event)"
      @click.capture="onThumbClickCapture(entry, $event)"
      @keydown.capture="onThumbKeydown(entry, index, $event)"
    />
  </div>
</template>

<style scoped>
.composer-media-rail {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--p-composer-media-inset) var(--p-composer-media-inset) 0;
  overflow-x: auto;
  scrollbar-width: none;
  touch-action: pan-y;
}

.composer-media-drop-indicator {
  position: absolute;
  top: var(--p-composer-media-inset);
  z-index: 2;
  width: var(--space-05);
  height: var(--p-composer-media-thumb);
  border-radius: var(--radius-full);
  background: var(--color-text);
  transform: translateX(-50%);
  pointer-events: none;
}

.composer-media-rail :deep(.media-thumb) {
  transition: transform var(--duration-fast) var(--ease-in-out);
}

.composer-media-rail :deep(.media-thumb.is-dragging) {
  z-index: 3;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .composer-media-rail :deep(.media-thumb) {
    transition: none;
  }
}

.composer-media-rail::-webkit-scrollbar {
  display: none;
}
</style>
