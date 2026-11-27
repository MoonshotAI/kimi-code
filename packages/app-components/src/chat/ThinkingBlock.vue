<script setup lang="ts">
import { useHistoryState } from './historyState';
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { formatDuration } from '@moonshot-ai/app-components';
import { PinScrollKey, track } from '@moonshot-ai/app-client/contracts';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
    startedAt?: string;
    durationMs?: number;
    instantReveal?: boolean;
  }>(),
  { mobile: false, streaming: false, startedAt: undefined, durationMs: undefined, instantReveal: false },
);

const open = useHistoryState('thinking:open', false);
const { t, locale } = useI18n();

watch(
  () => props.streaming,
  (now, prev) => {
    if (prev && !now) open.value = false;
  },
);

const nowMs = ref(Date.now());
watch(
  () => [props.streaming, props.startedAt] as const,
  ([streaming, startedAt], _prev, onCleanup) => {
    if (!streaming || !startedAt) return;
    nowMs.value = Date.now();
    const timer = setInterval(() => {
      nowMs.value = Date.now();
    }, 1000);
    onCleanup(() => clearInterval(timer));
  },
  { immediate: true },
);

const elapsedLabel = computed(() => {
  if (props.streaming && props.startedAt) {
    const startMs = Date.parse(props.startedAt);
    return Number.isFinite(startMs) ? formatDuration(nowMs.value - startMs, locale.value) : '';
  }
  if (props.durationMs !== undefined) {
    const span = formatDuration(props.durationMs, locale.value);
    return span ? `· ${span}` : '';
  }
  return '';
});

const pinScroll = inject(PinScrollKey, () => {});
const headEl = ref<HTMLElement | null>(null);
const bodyInnerEl = ref<HTMLElement | null>(null);

const instant = ref(false);

function onHeadClick(): void {
  if (!open.value) {
    const tall =
      (bodyInnerEl.value?.scrollHeight ?? 0) >
      (typeof window !== 'undefined' ? window.innerHeight : 0);
    instant.value = props.instantReveal || (props.streaming && tall);
  }
  open.value = !open.value;
  track('ui_element_toggled', { element: 'thinking_block', expanded: open.value, sample_rate: 1 });
  if (props.streaming) return;
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}
</script>

<template>
  <div class="think" :class="{ mob: mobile, open, streaming }">
    <button
      ref="headEl"
      class="think-head"
      type="button"
      :aria-expanded="open"
      @click="onHeadClick"
    >
      <span class="think-ic" aria-hidden="true"><Icon name="thinking" size="sm" /></span>
      <span class="think-title">{{ streaming ? t('thinking.streaming') : t('thinking.panelTitle') }}</span>
      <span v-if="elapsedLabel" class="think-time">{{ elapsedLabel }}</span>
      <Icon class="think-car" name="chevron-right" size="sm" />
    </button>
    <div class="think-body" :class="{ open, instant }" :inert="!open">
      <div ref="bodyInnerEl" class="think-body-inner">
        <pre class="think-text">{{ text }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.think {
  --think-gutter: 20px;
  --think-gap: var(--space-2);
  margin: 0;
  transition: margin-top var(--duration-base) var(--ease-out);
}

.think-head {
  display: flex;
  align-items: center;
  gap: var(--think-gap);
  width: 100%;
  min-height: var(--think-gutter);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--think-gutter);
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
.think-head:hover {
  color: var(--color-text);
}
.think-head:focus-visible {
  outline: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--p-focus-ring);
}

.think-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--think-gutter);
  height: var(--think-gutter);
  color: var(--color-text-faint);
}
.think-ic :deep(.kw-icon) {
  width: 18px;
  height: 18px;
}

.think-title {
  font-weight: var(--weight-regular);
  flex: none;
}

.think-time {
  color: var(--color-text-faint);
  font-weight: var(--weight-regular);
  flex: none;
}

.think.streaming .think-title {
  animation: ui-breathe 1.6s var(--ease-in-out) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .think {
    transition: none;
  }
  .think.streaming .think-title {
    animation: none;
  }
}

.think-car {
  color: var(--color-text-faint);
  flex: none;
  width: 12px;
  height: 12px;
  transition: transform var(--duration-base) var(--ease-out);
}
.think.open .think-car {
  transform: rotate(90deg);
}

.think-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.think-body.instant {
  transition: none;
}
.think-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.think-body-inner {
  position: relative;
  min-height: 0;
  overflow: hidden;
  padding-left: calc(var(--think-gutter) + var(--think-gap));
}
.think-body-inner::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc((var(--think-gutter) - var(--p-hairline)) / 2);
  width: var(--p-hairline);
  background-image: repeating-linear-gradient(
    to bottom,
    var(--color-line) 0 2px,
    transparent 2px 4px
  );
}

.think-text {
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  font-weight: var(--weight-regular);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 6px 0 0;
}

.mob .think-text {
  color: var(--color-text-faint);
}
</style>
