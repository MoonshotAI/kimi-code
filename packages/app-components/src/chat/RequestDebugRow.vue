<script setup lang="ts">
import { computed } from 'vue';
import { formatStepMs, formatTokens, requestCacheHitRate, requestInputTotal, requestTps } from '@moonshot-ai/app-core/lib';
import type { ConversationRequestDebug } from '@moonshot-ai/app-core/conversation';

const props = defineProps<{
  debug: ConversationRequestDebug;
}>();

const summary = computed(() => {
  const { usage, timing, finish_reason: finishReason } = props.debug;
  const tps = requestTps(props.debug);
  const parts: string[] = [];
  if (timing?.first_token_ms !== undefined) parts.push(`TTFT ${formatStepMs(timing.first_token_ms)}`);
  if (tps !== undefined) parts.push(`${tps.toFixed(1)} tok/s`);
  if (usage !== undefined) {
    const cacheHitRate = requestCacheHitRate(usage);
    parts.push(`in ${formatTokens(requestInputTotal(usage))}${cacheHitRate === undefined ? '' : ` (cache ${cacheHitRate}%)`}`);
    parts.push(`out ${formatTokens(usage.output)}`);
  }
  if (finishReason !== undefined) parts.push(finishReason);
  return parts.join(' · ');
});

const detail = computed(() => {
  const { usage, timing } = props.debug;
  return [
    ...Object.entries(timing ?? {}).map(([name, ms]) => `${name} ${ms}`),
    ...Object.entries(usage ?? {}).map(([name, tokens]) => `${name} ${tokens}`),
  ].join('\n');
});
</script>

<template>
  <div class="request-debug" role="note" :title="detail">{{ summary }}</div>
</template>

<style scoped>
.request-debug {
  margin-top: 2px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
</style>
