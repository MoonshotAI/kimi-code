<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Kbd } from '@moonshot-ai/app-ui';
import type { BrowserValue } from '../browserToolView';
import BrowserUrl from './BrowserUrl.vue';

const props = defineProps<{ value: BrowserValue | null }>();
const { t } = useI18n();

function pad(part: number): string {
  return String(part).padStart(2, '0');
}

function absoluteTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const scaled = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${scaled} · ${bytes} B`;
}

const plain = computed(() => {
  const value = props.value;
  if (value === null) return t('tools.browser.detail.empty');
  switch (value.type) {
    case 'number': return String(value.value);
    case 'bool': return t(value.value ? 'tools.browser.detail.yes' : 'tools.browser.detail.no');
    case 'duration': return `${value.ms} ms`;
    case 'time': return absoluteTime(value.ms);
    case 'bytes': return byteSize(value.value);
    case 'point': return `(${value.x}, ${value.y})`;
    case 'size': return `${value.width} × ${value.height}`;
    case 'region': return `(${value.x}, ${value.y}) · ${value.width} × ${value.height}`;
    default: return '';
  }
});
</script>

<template>
  <span v-if="value === null" class="bv bv-empty">{{ plain }}</span>
  <span v-else-if="value.type === 'text'" class="bv bv-text">{{ value.text }}</span>
  <span v-else-if="value.type === 'code'" class="bv bv-code">{{ value.text }}</span>
  <BrowserUrl v-else-if="value.type === 'url'" :url="value.url" />
  <Kbd v-else-if="value.type === 'keys'" :keys="value.keys" literal />
  <span v-else-if="value.type === 'element'" class="bv bv-element">
    <span class="bv-text">{{ value.name || t('tools.browser.element') }}</span>
    <span class="bv-ref">{{ value.ref }}</span>
  </span>
  <span v-else-if="value.type === 'point' || value.type === 'size' || value.type === 'region'" class="bv bv-geo">{{ plain }}</span>
  <span v-else class="bv bv-num">{{ plain }}</span>
</template>

<style scoped>
.bv {
  min-width: 0;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.bv-empty {
  color: var(--color-text-faint);
}
.bv-text {
  white-space: pre-wrap;
}
.bv-code,
.bv-ref {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-autospace: no-autospace;
}
.bv-num {
  font-variant-numeric: tabular-nums;
  text-autospace: no-autospace;
}
.bv-geo {
  white-space: nowrap;
  text-autospace: no-autospace;
}
.bv-element {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.bv-ref {
  color: var(--color-text-faint);
}
</style>
