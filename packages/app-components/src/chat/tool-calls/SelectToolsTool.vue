<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { useHistoryState } from '../historyState';
import { parseSelectToolsNames, parseSelectToolsResult } from './selectToolsTool';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed(() => props.tool.status);
const requested = computed(() => parseSelectToolsNames(props.tool.arg));
const result = computed(() =>
  status.value !== 'running' && props.tool.resultText !== undefined
    ? parseSelectToolsResult(props.tool.resultText)
    : null,
);

const hasParsedResult = computed(() =>
  result.value !== null &&
  (result.value.loaded.length > 0 || result.value.alreadyAvailable.length > 0 || result.value.unknown.length > 0),
);

const requestedMatchesLoaded = computed(() => {
  const loaded = new Set(result.value?.loaded ?? []);
  const names = new Set(requested.value);
  return names.size === loaded.size && [...names].every((name) => loaded.has(name));
});

const summary = computed(() => {
  if (status.value === 'running') {
    return requested.value.length > 0
      ? t('tools.selectTools.loading', { count: requested.value.length })
      : t('tools.selectTools.loadingAny');
  }
  const parts: string[] = [];
  if (result.value !== null) {
    if (result.value.loaded.length > 0) {
      parts.push(t('tools.selectTools.loaded', { count: result.value.loaded.length }));
    }
    if (result.value.alreadyAvailable.length > 0) {
      parts.push(t('tools.selectTools.alreadyAvailable', { count: result.value.alreadyAvailable.length }));
    }
    if (result.value.unknown.length > 0) {
      parts.push(t('tools.selectTools.unknown', { count: result.value.unknown.length }));
    }
  }
  if (parts.length > 0) return parts.join(' · ');
  if (status.value === 'error') return t('tools.selectTools.failure');
  if (props.tool.resultText?.trim().length === 0) return t('tools.selectTools.empty');
  return t('tools.selectTools.fallback');
});

const details = computed(() => {
  const rows = [
    { key: 'requested', label: t('tools.selectTools.field.requested'), names: requestedMatchesLoaded.value ? [] : requested.value },
    { key: 'loaded', label: t('tools.selectTools.field.loaded'), names: result.value?.loaded ?? [] },
    {
      key: 'alreadyAvailable',
      label: t('tools.selectTools.field.alreadyAvailable'),
      names: result.value?.alreadyAvailable ?? [],
    },
    { key: 'unknown', label: t('tools.selectTools.field.unknown'), names: result.value?.unknown ?? [] },
  ];
  return rows.filter((row) => row.names.length > 0);
});

const rawLines = computed(() => {
  if (status.value === 'running') return [];
  if (status.value !== 'error' && hasParsedResult.value) return result.value?.notes ?? [];
  const text = props.tool.resultText ?? props.tool.output?.join('\n') ?? '';
  return text.length > 0 ? text.split('\n') : [];
});
const canExpand = computed(() => details.value.length > 0 || rawLines.value.length > 0);
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [
    props.tool.defaultExpanded,
    props.tool.arg,
    props.tool.resultText,
    props.tool.output?.length,
    props.tool.status,
  ] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="tool" size="sm" /></template>
    <span class="tl-name">{{ summary }}</span>
    <span v-if="status === 'running' && requested.length > 0" class="tl-faint sts-requested">
      {{ requested.join(', ') }}
    </span>
    <template #body>
      <ToolPanel scroll>
        <dl v-if="details.length > 0" class="sts-fields">
          <template v-for="row in details" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd class="mono">{{ row.names.join('\n') }}</dd>
          </template>
        </dl>
        <OutputPanel v-if="rawLines.length > 0" class="sts-raw" :lines="rawLines" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.sts-requested {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sts-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-base);
  line-height: 20px;
}
.sts-fields dt {
  color: var(--color-text-faint);
}
.sts-fields dd {
  min-width: 0;
  margin: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sts-fields dd.mono {
  font-family: var(--font-mono);
}
.sts-raw {
  margin-top: var(--space-2);
}
</style>
