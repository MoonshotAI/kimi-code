<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, EmptyState, Icon, IconButton, ScrollArea, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import { getKimiWebApi, sessionObservationOptions, useKimiWebClient } from '@moonshot-ai/app-client/client';
import { formatTokens } from '@moonshot-ai/app-core/lib';
import type {
  ReadRequestOptions,
  SessionContextGroup,
  SessionContextItemSummary,
  SessionContextItemsResponse,
  SessionContextSummary,
} from '@moonshot-ai/app-core/api';
import ContextItemDialog from './ContextItemDialog.vue';

type FetchMode = 'reset' | 'more' | 'refresh';

const props = defineProps<{ sessionId: string }>();
const { t, te } = useI18n();
const client = useKimiWebClient();

const PAGE_LIMIT = 100;
const MAX_REQUEST_LIMIT = 500;
const selectedFilterRoles = ref<string[]>([]);
const summary = shallowRef<SessionContextSummary | null>(null);
const tools = shallowRef<SessionContextItemSummary[]>([]);
const items = shallowRef<SessionContextItemSummary[]>([]);
const total = ref(0);
const hasMore = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const toolsOpen = ref(false);
const selectedId = ref('');
let requestSeq = 0;

const usedTokens = computed(() => summary.value?.tokens.used ?? client.status.value?.ctxUsed ?? 0);
const maxTokens = computed(() => summary.value?.tokens.max ?? client.status.value?.ctxMax ?? 0);
const contextUsageLabel = computed(() => {
  const used = formatTokens(usedTokens.value);
  if (maxTokens.value <= 0) return `${t('inspector.usedLabel')} ${used}`;
  return t('inspector.usageSummary', {
    used,
    remaining: formatTokens(Math.max(0, maxTokens.value - usedTokens.value)),
  });
});
const capacityRatio = computed(() =>
  maxTokens.value > 0 ? Math.min(1, Math.max(0, usedTokens.value / maxTokens.value)) : 1,
);

const selectedRoles = computed(() => selectedFilterRoles.value);
const filtering = computed(() => selectedFilterRoles.value.length > 0);
const definitionOnly = computed(() =>
  selectedRoles.value.length === 1 && selectedRoles.value[0] === 'definition',
);

async function requestItems(
  sid: string,
  offset: number,
  count: number,
  options?: ReadRequestOptions,
): Promise<SessionContextItemsResponse> {
  const roles = filtering.value ? selectedRoles.value : undefined;
  const starts: number[] = [];
  for (let start = offset; start < offset + count; start += MAX_REQUEST_LIMIT) starts.push(start);
  const pages = await Promise.all(starts.map((start) =>
    getKimiWebApi().getSessionContextItems(sid, {
      roles,
      offset: start,
      limit: Math.min(MAX_REQUEST_LIMIT, offset + count - start),
    }, options),
  ));
  return { ...pages.at(-1)!, items: pages.flatMap((page) => page.items) };
}

async function fetchContext(mode: FetchMode, options?: ReadRequestOptions): Promise<void> {
  const sid = props.sessionId;
  if (!sid) {
    summary.value = null;
    tools.value = [];
    items.value = [];
    total.value = 0;
    hasMore.value = false;
    loading.value = false;
    return;
  }
  const loadedCount = items.value.length + (loadingMore.value ? PAGE_LIMIT : 0);
  const offset = mode === 'more' ? items.value.length : 0;
  const count = mode === 'refresh' ? Math.max(PAGE_LIMIT, loadedCount) : PAGE_LIMIT;
  const seq = ++requestSeq;
  if (mode === 'reset') loading.value = true;
  if (mode === 'more') loadingMore.value = true;
  error.value = '';
  try {
    const res = await requestItems(sid, offset, count, options);
    if (seq !== requestSeq || props.sessionId !== sid) return;
    summary.value = res.summary;
    tools.value = res.tools;
    items.value = mode === 'more' ? [...items.value, ...res.items] : res.items;
    total.value = res.total;
    hasMore.value = res.has_more;
  } catch (err) {
    if (seq !== requestSeq || props.sessionId !== sid) return;
    if (err instanceof Error && err.name === 'AbortError') return;
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (seq === requestSeq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

watch(
  () => props.sessionId,
  () => {
    selectedFilterRoles.value = [];
    selectedId.value = '';
    summary.value = null;
    tools.value = [];
    items.value = [];
    void fetchContext('reset');
  },
  { immediate: true },
);

watch(
  [
    () => client.status.value?.ctxUsed,
    () => client.status.value?.ctxMax,
    () => client.status.value?.modelId,
    () => client.activity.value,
  ],
  () => {
    if (props.sessionId) void fetchContext('refresh', sessionObservationOptions(props.sessionId));
  },
);

function toggleRole(nextRole: string): void {
  selectedFilterRoles.value = selectedFilterRoles.value.includes(nextRole)
    ? selectedFilterRoles.value.filter((role) => role !== nextRole)
    : [...selectedFilterRoles.value, nextRole];
  selectedId.value = '';
  void fetchContext('reset');
}

function selectAllRoles(): void {
  selectedFilterRoles.value = [];
  selectedId.value = '';
  void fetchContext('reset');
}

const segments = computed(() =>
  (summary.value?.groups ?? []).filter((g) => g.chars > 0),
);

function groupLabel(group: SessionContextGroup): string {
  const countKey = `inspector.compositionCount.${group.role}`;
  const count = t(te(countKey) ? countKey : 'inspector.compositionCount.unknown', {
    n: group.count.toLocaleString(),
  });
  return `${count} · ${t('inspector.characters', { n: group.chars.toLocaleString() })}`;
}

function groupPct(group: SessionContextGroup): number {
  const totalChars = summary.value?.total_chars ?? 0;
  if (totalChars <= 0) return 0;
  return Math.round((group.chars / totalChars) * 100);
}

const showGroupedTools = computed(() => !filtering.value && tools.value.length > 0);
const definitionSize = computed(() =>
  tools.value.reduce((acc, item) => acc + item.chars, 0),
);

const navigableItems = computed<SessionContextItemSummary[]>(() => {
  if (definitionOnly.value) return items.value;
  if (showGroupedTools.value && toolsOpen.value) {
    const sys = items.value[0]?.role === 'system' ? [items.value[0]] : [];
    const rest = items.value[0]?.role === 'system' ? items.value.slice(1) : items.value;
    return [...sys, ...tools.value, ...rest];
  }
  return items.value;
});

const navigableTotal = computed(() =>
  total.value + (showGroupedTools.value && toolsOpen.value ? tools.value.length : 0),
);
const selectedIndex = computed(() =>
  navigableItems.value.findIndex((item) => item.id === selectedId.value),
);
const selectedItem = computed(() =>
  selectedIndex.value >= 0 ? navigableItems.value[selectedIndex.value] : undefined,
);

async function navigateItem(direction: number): Promise<void> {
  const target = selectedIndex.value + direction;
  if (target >= navigableItems.value.length && hasMore.value && !loadingMore.value) {
    await fetchContext('more');
  }
  const next = navigableItems.value[target];
  if (next) selectedId.value = next.id;
}

const remainingCount = computed(() => Math.max(0, total.value - items.value.length));
</script>

<template>
  <section class="model-inspector" :aria-label="t('inspector.title')">
    <div v-if="error" class="current-error" role="alert">
      <span>{{ error }}</span>
      <Button v-if="!summary" size="sm" variant="ghost" @click="fetchContext('reset')">{{ t('inspector.retry') }}</Button>
    </div>
    <div v-if="loading && !summary" class="current-loading"><Spinner size="sm" /></div>
    <EmptyState v-else-if="!sessionId" :title="t('inspector.selectSession')" />
    <ScrollArea v-else-if="summary" class="context-scroll" :class="{ refreshing: loading }" orientation="both">
      <div class="context-overview">
        <div class="overview-toolbar">
          <span class="current-chars">{{ contextUsageLabel }}</span>
          <Tooltip :text="t('inspector.currentContextHint')">
            <span tabindex="0" class="current-time">
              {{ summary ? new Date(summary.captured_at).toLocaleTimeString() : '—' }}
              <Icon name="info" size="sm" />
            </span>
          </Tooltip>
          <IconButton
            size="sm"
            :label="t('inspector.refresh')"
            :tooltip="t('inspector.refresh')"
            :disabled="loading || !sessionId"
            @click="fetchContext('refresh')"
          >
            <Icon name="refresh" size="sm" />
          </IconButton>
        </div>
        <div v-if="summary.total_chars > 0" class="composition-bar" :aria-label="t('inspector.composition')">
          <Tooltip v-for="group in segments" :key="group.role" :text="groupLabel(group)">
            <button
              type="button"
              :data-role="group.role"
              :style="{ width: `${(group.chars / summary.total_chars) * capacityRatio * 100}%` }"
              :class="{ dimmed: filtering && !selectedFilterRoles.includes(group.role) }"
              :aria-label="groupLabel(group)"
              :aria-pressed="filtering && selectedFilterRoles.includes(group.role)"
              @click="toggleRole(group.role)"
            />
          </Tooltip>
        </div>
        <div class="composition-legend">
          <Tooltip
            v-for="group in summary.groups"
            :key="group.role"
            :text="`${groupLabel(group)} · ${groupPct(group)}%`"
          >
            <button
              class="legend-button"
              type="button"
              :data-role="group.role"
              :class="{ muted: filtering && !selectedFilterRoles.includes(group.role), selected: filtering && selectedFilterRoles.includes(group.role) }"
              :aria-label="groupLabel(group)"
              :aria-pressed="filtering && selectedFilterRoles.includes(group.role)"
              @click="toggleRole(group.role)"
            >
              <span class="legend-marker" />
              <span>{{ t(`inspector.role.${group.role}`, group.role) }}</span>
              <span class="legend-value">{{ groupPct(group) }}%</span>
            </button>
          </Tooltip>
          <Button v-if="filtering" size="sm" variant="text" @click="selectAllRoles">{{ t('inspector.clearFilter') }}</Button>
        </div>
      </div>

      <div class="context-columns">
        <span>{{ t('inspector.messageOrder') }}</span>
        <span>{{ t('inspector.characterCount') }}</span>
      </div>

      <div class="context-blocks">
        <template v-if="showGroupedTools">
          <button
            v-if="items[0]?.role === 'system'"
            type="button"
            class="context-block context-row"
            data-role="system"
            aria-haspopup="dialog"
            @click="selectedId = items[0].id"
          >
            <Icon class="open-message" name="expand" size="sm" />
            <span class="role-marker" />
            <span class="block-role">{{ t('inspector.role.system') }}</span>
            <span class="block-preview">{{ items[0].preview }}</span>
            <span class="block-size">{{ items[0].chars.toLocaleString() }}</span>
          </button>

          <details
            class="context-block"
            data-role="definition"
            @toggle.stop="toolsOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>
              <Icon class="disclosure" name="chevron-right" size="sm" />
              <span class="role-marker" />
              <span class="block-role">{{ t('inspector.role.definition') }} · {{ tools.length }}</span>
              <span class="block-preview">{{ tools.map((item) => item.name).join(', ') }}</span>
              <span class="block-size">{{ definitionSize.toLocaleString() }}</span>
            </summary>
            <div v-if="toolsOpen" class="nested-tools">
              <button
                v-for="tool in tools"
                :key="tool.id"
                type="button"
                class="context-block context-row"
                data-role="definition"
                aria-haspopup="dialog"
                @click="selectedId = tool.id"
              >
                <Icon class="open-message" name="expand" size="sm" />
                <span class="role-marker" />
                <span class="block-role">{{ t('inspector.role.definition') }}</span>
                <span class="block-preview">
                  <span v-if="tool.name" class="block-name">{{ tool.name }}</span>
                  <template v-if="tool.name && tool.preview"> · </template>{{ tool.preview }}
                </span>
                <span class="block-size">{{ tool.chars.toLocaleString() }}</span>
              </button>
            </div>
          </details>

          <button
            v-for="item in (items[0]?.role === 'system' ? items.slice(1) : items)"
            :key="item.id"
            type="button"
            class="context-block context-row"
            :data-role="item.role"
            aria-haspopup="dialog"
            @click="selectedId = item.id"
          >
            <Icon class="open-message" name="expand" size="sm" />
            <span v-if="item.sequence !== undefined" class="block-index">{{ String(item.sequence).padStart(2, '0') }}</span>
            <span v-else class="role-marker" />
            <span class="block-role">{{ t(`inspector.role.${item.role}`, item.role) }}</span>
            <span class="block-preview">
              <span v-if="item.name" class="block-name">{{ item.name }}</span>
              <template v-if="item.name && item.preview"> · </template>{{ item.preview }}
            </span>
            <span class="block-size">{{ item.chars.toLocaleString() }}</span>
          </button>
        </template>

        <template v-else>
          <button
            v-for="item in items"
            :key="item.id"
            type="button"
            class="context-block context-row"
            :data-role="item.role"
            aria-haspopup="dialog"
            @click="selectedId = item.id"
          >
            <Icon class="open-message" name="expand" size="sm" />
            <span v-if="item.sequence !== undefined" class="block-index">{{ String(item.sequence).padStart(2, '0') }}</span>
            <span v-else class="role-marker" />
            <span class="block-role">{{ t(`inspector.role.${item.role}`, item.role) }}</span>
            <span class="block-preview">
              <span v-if="item.name" class="block-name">{{ item.name }}</span>
              <template v-if="item.name && item.preview"> · </template>{{ item.preview }}
            </span>
            <span class="block-size">{{ item.chars.toLocaleString() }}</span>
          </button>
        </template>

        <div v-if="hasMore" class="show-more-wrap">
          <Button size="sm" variant="ghost" :loading="loadingMore" @click="fetchContext('more')">
            {{ t('inspector.showMore', { n: remainingCount }) }}
          </Button>
        </div>
      </div>
    </ScrollArea>

    <ContextItemDialog
      v-if="selectedItem"
      :session-id="sessionId"
      :item="selectedItem"
      :index="selectedIndex"
      :total="navigableTotal"
      @close="selectedId = ''"
      @navigate="(direction) => void navigateItem(direction)"
    />
  </section>
</template>

<style scoped>
.model-inspector { height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--color-bg); color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-sm); -webkit-app-region: no-drag; container: inspector-detail / inline-size; }
.model-inspector :deep([data-role="system"]) { --context-color: var(--color-text-muted); }
.model-inspector :deep([data-role="definition"]) { --context-color: var(--color-context-definition); }
.model-inspector :deep([data-role="user"]) { --context-color: var(--color-info); }
.model-inspector :deep([data-role="assistant"]) { --context-color: var(--color-context-assistant); }
.model-inspector :deep([data-role="tool"]) { --context-color: var(--color-orange); }
.overview-toolbar { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); white-space: nowrap; }
.overview-toolbar .current-chars { flex: 1; }
.current-chars { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.current-time { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--color-text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.current-time:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.current-error { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3); color: var(--color-danger); font-size: var(--text-xs); overflow-wrap: anywhere; }
.current-loading { display: flex; align-items: center; justify-content: center; flex: 1; }
.context-scroll { flex: 1; min-height: 0; }
.refreshing { opacity: .5; }
.context-overview { padding: var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); }
.composition-bar { display: flex; height: var(--space-3); overflow: hidden; border-radius: var(--radius-context-segment); background: var(--color-fill-2); }
.composition-bar button { border: 0; border-right: var(--p-hairline) solid var(--color-bg); border-radius: var(--radius-context-segment); background: var(--context-color, var(--color-text-faint)); min-width: var(--space-2); padding: 0; cursor: pointer; }
.composition-bar button:hover { opacity: .8; }
.composition-bar .dimmed { opacity: .25; }
.composition-legend { display: flex; gap: var(--space-2); margin-top: var(--space-2); overflow-x: auto; scrollbar-width: thin; white-space: nowrap; }
.legend-button { display: inline-flex; align-items: center; gap: var(--space-1); min-height: var(--space-8); flex: none; white-space: nowrap; background: transparent; border: 0; padding: var(--space-1); color: var(--color-text-muted); font: inherit; font-size: var(--text-xs); cursor: pointer; border-radius: var(--radius-xs); }
.legend-button:hover { background: var(--color-hover); }
.legend-button.muted { opacity: .4; }
.legend-button.selected { background: var(--color-selected); color: var(--color-text); box-shadow: var(--shadow-xs); }
.legend-button.muted .legend-marker { background: transparent; box-shadow: inset 0 0 0 var(--p-hairline) var(--context-color, var(--color-text-faint)); }
.legend-marker { width: var(--space-2); height: var(--space-2); border-radius: var(--radius-context-segment); background: var(--context-color, var(--color-text-faint)); flex: none; }
.legend-value { font-variant-numeric: tabular-nums; color: var(--color-text-faint); }
button:focus-visible, summary:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.context-columns { display: flex; justify-content: space-between; padding: var(--space-1) var(--space-3); font-size: var(--text-xs); color: var(--color-text-faint); border-bottom: var(--p-hairline) solid var(--color-line); }
.context-blocks { min-width: 0; }
.context-block { border-bottom: var(--p-hairline) solid var(--color-line); }
.context-block > summary, .context-row { display: flex; align-items: center; gap: var(--space-2); min-height: var(--space-8); padding: var(--space-1) var(--space-3); list-style: none; cursor: pointer; font-size: var(--text-sm); }
.context-row { width: 100%; border: 0; border-bottom: var(--p-hairline) solid var(--color-line); background: transparent; color: inherit; font-family: inherit; text-align: left; }
.context-block > summary::-webkit-details-marker { display: none; }
.context-block > summary:hover, .context-row:hover { background: var(--color-hover); }
.disclosure, .open-message { color: var(--color-text-faint); flex: none; }
.open-message { opacity: 0; }
.context-row:hover .open-message, .context-row:focus-visible .open-message { opacity: 1; }
.context-block[open] > summary { background: var(--color-selected); }
.context-block[open] > summary .disclosure { transform: rotate(90deg); }
.role-marker { width: var(--space-2); height: var(--space-2); margin-inline: var(--space-1); border-radius: var(--radius-context-segment); background: var(--context-color, var(--color-text-muted)); flex: none; }
.block-index { width: 3ch; color: var(--context-color, var(--color-text-muted)); font: var(--text-xs) var(--font-mono); flex: none; }
.block-role { color: var(--color-text-muted); flex: none; }
.block-name { color: var(--color-text); font-family: var(--font-mono); }
.block-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-faint); }
.block-size { font: var(--text-xs) var(--font-mono); color: var(--color-text-faint); flex: none; }
.nested-tools { margin-left: var(--space-4); border-left: var(--p-hairline) solid var(--color-line); }
.show-more-wrap { padding: var(--space-2) var(--space-3); }
@container inspector-detail (max-width: 640px) { .legend-value { display: none; } }
@media (hover: none) { .legend-button, .context-block > summary, .context-row { min-height: calc(var(--space-8) + var(--space-3)); } .open-message { opacity: 1; } }
</style>
