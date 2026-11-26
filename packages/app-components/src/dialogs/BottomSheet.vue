<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, openSheetCount } from '@moonshot-ai/app-ui';
import { settleDraggedElement, usePointerDragSession } from '@moonshot-ai/app-client/composables';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FLING_VELOCITY_THRESHOLD = 0.5;
const FLING_IDLE_DECAY_MS = 80;

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    closeOnEsc?: boolean;
    showBack?: boolean;
    bodyScroll?: boolean;
    maxHeightRatio?: number;
  }>(),
  { title: '', closeOnEsc: true, showBack: false, bodyScroll: true, maxHeightRatio: 0.86 },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  close: [];
  back: [];
}>();

const { t } = useI18n();
const bodyEl = ref<HTMLElement>();
const panelEl = ref<HTMLElement>();
const bodyScrolled = ref(false);
const viewportStyle = ref<Record<string, string>>({});
const panelMaxHeight = ref('');
const dragOffset = ref(0);
const dragging = ref(false);
let previouslyFocused: HTMLElement | null = null;
let dragStartY = 0;
let dragLastY = 0;
let dragLastTime = 0;
let dragVelocity = 0;

function close(): void {
  emit('update:modelValue', false);
  emit('close');
}

function sheetFocusables(): HTMLElement[] {
  return panelEl.value ? Array.from(panelEl.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.closeOnEsc) {
    close();
    return;
  }
  if (e.key !== 'Tab') return;
  const list = sheetFocusables();
  const first = list[0];
  const last = list[list.length - 1];
  if (!first || !last) {
    e.preventDefault();
    panelEl.value?.focus();
    return;
  }
  const active = document.activeElement;
  const inside = panelEl.value?.contains(active) ?? false;
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

function onBodyScroll(e: Event): void {
  bodyScrolled.value = ((e.target as HTMLElement | null)?.scrollTop ?? 0) > 0;
}

function syncViewport(): void {
  const vv = window.visualViewport;
  if (!vv) {
    viewportStyle.value = {};
    panelMaxHeight.value = '';
    return;
  }
  const keyboardInset = window.innerHeight - (vv.offsetTop + vv.height);
  if (keyboardInset <= 1 && vv.offsetTop <= 1) {
    viewportStyle.value = {};
    panelMaxHeight.value = '';
    return;
  }
  viewportStyle.value = {
    top: `${Math.round(vv.offsetTop)}px`,
    bottom: 'auto',
    height: `${Math.round(vv.height)}px`,
  };
  panelMaxHeight.value = `${Math.max(160, Math.floor(Math.min(window.innerHeight * props.maxHeightRatio, vv.height)))}px`;
}

const grabDrag = usePointerDragSession<void>({
  threshold: 4,
  allowTouch: true,
  begin: ({ origin, point }) => {
    panelEl.value?.getAnimations?.().forEach((animation) => animation.cancel());
    dragStartY = origin.y;
    dragLastY = point.y;
    dragLastTime = performance.now();
    dragVelocity = 0;
    dragOffset.value = Math.max(0, point.y - dragStartY);
    dragging.value = true;
    return true;
  },
  move: (point) => {
    const now = performance.now();
    const dt = now - dragLastTime;
    if (dt > 0) dragVelocity = (point.y - dragLastY) / dt;
    dragLastY = point.y;
    dragLastTime = now;
    dragOffset.value = Math.max(0, point.y - dragStartY);
  },
  end: (dropped, point) => {
    dragging.value = false;
    const offset = Math.max(0, point.y - dragStartY);
    dragOffset.value = 0;
    const idleMs = performance.now() - dragLastTime;
    const releaseVelocity = idleMs >= FLING_IDLE_DECAY_MS ? 0 : dragVelocity * (1 - idleMs / FLING_IDLE_DECAY_MS);
    const threshold = Math.min(120, (panelEl.value?.offsetHeight || 320) * 0.25);
    if (dropped && (offset > threshold || releaseVelocity > FLING_VELOCITY_THRESHOLD)) {
      close();
      return;
    }
    if (panelEl.value) settleDraggedElement(panelEl.value, 0, offset);
  },
});

function onGrabClick(): void {
  if (grabDrag.consumeClick()) return;
  close();
}

const panelStyle = computed(() => {
  const style: Record<string, string> = {
    maxHeight: panelMaxHeight.value || `calc(var(--app-height, 100dvh) * ${props.maxHeightRatio})`,
  };
  if (dragOffset.value > 0) style.transform = `translateY(${dragOffset.value}px)`;
  return style;
});

watch(
  () => props.modelValue,
  async (open) => {
    if (open) openSheetCount.value += 1;
    else openSheetCount.value = Math.max(0, openSheetCount.value - 1);
    if (typeof document === 'undefined') return;
    if (open) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      bodyScrolled.value = false;
      dragOffset.value = 0;
      document.addEventListener('keydown', onKeydown);
      syncViewport();
      window.visualViewport?.addEventListener('resize', syncViewport);
      window.visualViewport?.addEventListener('scroll', syncViewport);
      await nextTick();
      if (props.modelValue && panelEl.value && !panelEl.value.contains(document.activeElement)) {
        panelEl.value.focus();
      }
    } else {
      grabDrag.cancel();
      document.removeEventListener('keydown', onKeydown);
      window.visualViewport?.removeEventListener('resize', syncViewport);
      window.visualViewport?.removeEventListener('scroll', syncViewport);
      const restoreTo = previouslyFocused;
      previouslyFocused = null;
      if (restoreTo?.isConnected) {
        await nextTick();
        restoreTo.focus();
      }
    }
  },
  { immediate: true },
);

watch([() => props.title, () => props.showBack], () => {
  bodyScrolled.value = false;
});

defineExpose({ panelEl, bodyEl });

onUnmounted(() => {
  if (props.modelValue) {
    openSheetCount.value = Math.max(0, openSheetCount.value - 1);
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  }
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeydown);
  if (typeof window !== 'undefined') {
    window.visualViewport?.removeEventListener('resize', syncViewport);
    window.visualViewport?.removeEventListener('scroll', syncViewport);
  }
});
</script>

<template>
  <Transition name="sheet">
    <div v-if="modelValue" class="sheet-root" :style="viewportStyle">
      <div class="sheet-scrim" @click="close" />
      <div
        ref="panelEl"
        class="sheet-panel"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="title || t('mobile.sheetLabel')"
        :style="panelStyle"
      >
        <button
          type="button"
          class="sheet-grab"
          :aria-label="t('mobile.closeSheet')"
          @pointerdown="grabDrag.onPointerDown($event, undefined)"
          @click="onGrabClick"
        />
        <div v-if="title || showBack" class="sheet-head" :class="{ 'has-back': showBack, 'is-scrolled': bodyScrolled }">
          <template v-if="showBack">
            <button type="button" class="sheet-back" :aria-label="t('mobile.back')" @click="emit('back')">
              <Icon name="chevron-left" size="md" />
            </button>
            <span class="sheet-title sheet-title--center">{{ title }}</span>
            <span class="sheet-head-spacer" aria-hidden="true" />
          </template>
          <span v-else class="sheet-title">{{ title }}</span>
        </div>
        <div
          ref="bodyEl"
          class="sheet-body"
          :class="{ 'is-fixed-layout': !bodyScroll }"
          @scroll.capture.passive="onBodyScroll"
        >
          <slot />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sheet-root {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.sheet-scrim {
  position: absolute;
  inset: 0;
  background: var(--color-scrim);
}

.sheet-panel {
  position: relative;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-bottom: none;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: var(--font-ui);
  color: var(--color-text);
}

.sheet-grab {
  flex: none;
  align-self: center;
  width: 72px;
  height: 22px;
  padding: 11px 0 6px;
  border: none;
  background: none;
  cursor: grab;
  touch-action: none;
  box-sizing: border-box;
}
.sheet-panel:focus {
  outline: none;
}
.sheet-grab:active {
  cursor: grabbing;
}
.sheet-grab::after {
  content: '';
  display: block;
  width: 38px;
  height: 5px;
  margin: 0 auto;
  border-radius: 2.5px;
  background: var(--color-line);
}

.sheet-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px 10px;
}
.sheet-head.has-back {
  height: 44px;
  padding: 0 4px;
  border-bottom: var(--p-hairline) solid transparent;
  box-sizing: border-box;
}
.sheet-head.has-back.is-scrolled {
  border-bottom-color: var(--color-line);
}
.sheet-back,
.sheet-head-spacer {
  flex: none;
  width: 44px;
  height: 44px;
}
.sheet-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
}
.sheet-back:active {
  background: var(--color-hover);
}
.sheet-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.sheet-title--center {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: max(16px, var(--safe-bottom, 0px));
  scrollbar-width: thin;
  scrollbar-color: var(--color-menu-scrollbar) transparent;
}
.sheet-body::-webkit-scrollbar {
  width: 4px;
}
.sheet-body::-webkit-scrollbar-track {
  background: transparent;
  margin-block: 4px;
}
.sheet-body::-webkit-scrollbar-thumb {
  border-radius: var(--radius-full);
  background: var(--color-menu-scrollbar);
}
.sheet-body:hover::-webkit-scrollbar-thumb {
  background: var(--color-menu-scrollbar-hover);
}
.sheet-body.is-fixed-layout {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: 0;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}
.sheet-enter-active .sheet-panel,
.sheet-leave-active .sheet-panel {
  transition: transform var(--duration-slow) var(--ease-out);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .sheet-panel,
.sheet-leave-to .sheet-panel {
  transform: translateY(102%);
}
</style>
