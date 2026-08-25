<!-- WebFetch tool: the row leads with the localized Fetch label, then the
     target host + first path segment; expanding shows the full URL above the
     fetched-content panel. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { parseArgRecord, str, urlHost } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const url = computed(() => {
  const d = parseArgRecord(props.tool.arg);
  return str(d?.url) ?? str(d?.uri) ?? '';
});
const host = computed(() => (url.value ? urlHost(url.value) : ''));

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="globe" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.web_fetch') }}</span>
    <span v-if="host">{{ host }}</span>
    <span v-else class="tl-dim">{{ tool.arg }}</span>
    <template #body>
      <div v-if="url" class="fetch-url">{{ url }}</div>
      <OutputPanel :lines="tool.output" :empty-text="t('tools.output.waiting')" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.fetch-url {
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  color: var(--color-text-faint);
  white-space: pre-wrap;
  word-break: break-all;
  margin-bottom: var(--space-1);
}
</style>
