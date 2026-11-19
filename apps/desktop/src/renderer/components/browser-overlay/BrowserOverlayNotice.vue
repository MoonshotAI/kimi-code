<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';

defineProps<{ message: string; linkLabel: string }>();
const emit = defineEmits<{ open: [] }>();

const trigger = ref<HTMLElement>();
const open = ref(false);
const cardStyle = ref<Record<string, string>>({});
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function place(): void {
  const el = trigger.value;
  if (el === undefined) return;
  const rect = el.getBoundingClientRect();
  const gutter = 8;
  const estimatedHeight = 72;
  const below = rect.bottom + 6 + estimatedHeight <= window.innerHeight - gutter;
  cardStyle.value = below
    ? { top: `${Math.round(rect.bottom + 6)}px`, right: `${gutter}px` }
    : { bottom: `${Math.round(window.innerHeight - rect.top + 6)}px`, right: `${gutter}px` };
  cardStyle.value.maxWidth = `${Math.max(160, window.innerWidth - gutter * 2)}px`;
}

function show(): void {
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  place();
  open.value = true;
}

function scheduleHide(): void {
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { open.value = false; }, 150);
}

onBeforeUnmount(() => { if (hideTimer !== undefined) clearTimeout(hideTimer); });
</script>

<template>
  <span ref="trigger" class="overlay-notice">
    <button
      type="button"
      class="overlay-notice__badge"
      :aria-label="message"
      @mouseenter="show"
      @mouseleave="scheduleHide"
      @focus="show"
      @blur="scheduleHide"
      @click="emit('open')"
    >
      <Icon name="alert-triangle" size="sm" />
    </button>
    <Teleport to="body">
      <span v-if="open" class="overlay-notice__card" :style="cardStyle" @mouseenter="show" @mouseleave="scheduleHide">
        <span class="overlay-notice__text">{{ message }}</span>
        <button type="button" class="overlay-notice__link" @click="emit('open')">{{ linkLabel }}</button>
      </span>
    </Teleport>
  </span>
</template>

<style scoped>
.overlay-notice { display: inline-flex; }
.overlay-notice__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-warning);
  cursor: pointer;
}
.overlay-notice__badge:hover { background: var(--color-hover); }
.overlay-notice__card {
  position: fixed;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}
.overlay-notice__text {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.overlay-notice__link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  cursor: pointer;
}
.overlay-notice__link:hover { text-decoration: underline; }
</style>
