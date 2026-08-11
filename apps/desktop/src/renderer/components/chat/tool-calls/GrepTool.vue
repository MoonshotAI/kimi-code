<!-- apps/web/src/components/chat/tool-calls/GrepTool.vue -->
<!-- Grep / content-search tool: the row leads with the localized Search label,
     then the pattern in mono plus its scope; expanding lists the matches as
     clickable rows (path:line → file preview). WebSearch results are not
     line-oriented, so for that kind the body falls back to the plain output
     panel. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { FilePreviewRequest, ToolCall } from '../../../types';
import { normalizeToolName } from '../../../lib/toolMeta';
import { parseArgRecord, str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ openFile: [target: FilePreviewRequest] }>();

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const isContentSearch = computed(() => normalizeToolName(props.tool.name) === 'grep');

const args = computed(() => parseArgRecord(props.tool.arg));
const pattern = computed(() => {
  const d = args.value;
  return str(d?.pattern) ?? str(d?.query) ?? str(d?.regex) ?? '';
});
const scope = computed(() => {
  const d = args.value;
  return str(d?.path) ?? str(d?.glob) ?? str(d?.include) ?? '';
});

interface GrepMatch {
  path?: string;
  line?: number;
  text: string;
}

/** Parse `path:line:text` (and `path-line-context`) output rows; rows that
    don't match the shape render as plain text. Blank rows (e.g. from a
    newline-terminated payload) are dropped first, same as GlobTool — they
    would otherwise inflate the result count and render empty match rows. */
const matches = computed<GrepMatch[]>(() =>
  (props.tool.output ?? [])
    .filter((raw) => raw.trim().length > 0)
    .map((raw) => {
      const m = /^(.+?):(\d+)[:-](.*)$/.exec(raw);
      if (m) return { path: m[1], line: Number(m[2]), text: (m[3] ?? '').trim() };
      return { text: raw };
    }),
);

const resultCount = computed(() => matches.value.length);

const hasOutput = computed(() => resultCount.value > 0);
const canExpand = computed(() => hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);

function openMatch(match: GrepMatch): void {
  if (!match.path) return;
  emit('openFile', { path: match.path, line: match.line });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="search" size="sm" /></template>
    <span class="tl-name">{{ t(isContentSearch ? 'tools.label.grep' : 'tools.label.search') }}</span>
    <span v-if="pattern" class="tl-mono">{{ pattern }}</span>
    <span v-else class="tl-dim">{{ tool.arg }}</span>
    <span v-if="scope" class="tl-faint">{{ scope }}</span>
    <template #trailing>
      <span v-if="resultCount > 0" class="tl-chip">{{ t('tools.chip.results', { count: resultCount }) }}</span>
    </template>
    <template #body>
      <div v-if="isContentSearch" class="match-list">
        <button
          v-for="(match, i) in matches"
          :key="i"
          class="match-row"
          :class="{ link: match.path }"
          type="button"
          @click="openMatch(match)"
        >
          <span v-if="match.path" class="mref">{{ match.path }}:{{ match.line }}</span>
          <span class="mtext">{{ match.text }}</span>
        </button>
      </div>
      <OutputPanel v-else :lines="tool.output" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.match-list {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  padding: var(--space-1);
  max-height: calc(12 * 1.6 * var(--content-font-size));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.match-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 2px var(--space-2);
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  color: var(--color-text);
  text-align: left;
  cursor: default;
}
.match-row.link {
  cursor: pointer;
}
.match-row.link:hover {
  background: var(--color-hover);
}
.match-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.mref {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-faint);
}
.match-row.link:hover .mref {
  color: var(--color-accent);
}
.mtext {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
