<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

interface GrepMatch {
  path?: string;
  line?: number;
  text: string;
}

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const { t } = useI18n();
const { panelApi, status, kind, args, argText } = useToolCard(props);
const isContentSearch = computed(() => kind.value === 'grep');
const pattern = computed(() => {
  const d = args.value;
  return str(d?.pattern) ?? str(d?.query) ?? str(d?.regex) ?? '';
});
const scope = computed(() => {
  const d = args.value;
  return str(d?.path) ?? str(d?.glob) ?? str(d?.include) ?? '';
});

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
const canExpand = computed(() => resultCount.value > 0);
const { open } = useToolCardExpansion(props, canExpand);

function openMatch(match: GrepMatch): void {
  if (!match.path) return;
  panelApi?.openFile({ path: match.path, line: match.line });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="search" size="sm" /></template>
    <span class="tl-name">{{ t(isContentSearch ? 'tools.label.grep' : 'tools.label.search') }}</span>
    <span v-if="pattern" class="tl-mono">{{ pattern }}</span>
    <span v-else-if="argText" class="tl-dim">{{ argText }}</span>
    <span v-if="scope" class="tl-faint">{{ scope }}</span>
    <span v-if="resultCount > 0" class="tl-chip">{{ t('tools.chip.results', { count: resultCount }) }}</span>
    <template #body>
      <ToolPanel scroll>
        <div v-if="isContentSearch" class="match-list">
          <button
            v-for="(match, i) in matches"
            :key="i"
            class="match-row"
            :class="{ link: match.path }"
            type="button"
            :data-file-path="match.path || undefined"
            @click="openMatch(match)"
          >
            <span v-if="match.path" class="mref">{{ match.path }}:{{ match.line }}</span>
            <span class="mtext">{{ match.text }}</span>
          </button>
        </div>
        <OutputPanel v-else :lines="tool.output" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.match-list {
  display: flex;
  flex-direction: column;
}
.match-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--content-font-size);
  line-height: 1.571;
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  color: var(--color-text);
  text-align: left;
  cursor: default;
}
.match-row.link {
  cursor: pointer;
}
.match-row.link:hover .mtext {
  color: var(--color-accent);
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
