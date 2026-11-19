<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { ModelDisplayKey, ResolveSwarmMembersKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { toolLabel } from '@moonshot-ai/app-components';
import { parseSwarmResult } from '@moonshot-ai/app-core/lib';
import { buildSwarmCardRows, type SwarmCardRow } from '@moonshot-ai/app-core/client';
import { Icon, ScrollArea, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const panelApi = inject(panelApiKey);

interface SwarmInput {
  description?: string;
  itemCount?: number;
}

function parseInput(arg: string): SwarmInput {
  if (!arg) return {};
  try {
    const obj = JSON.parse(arg) as Record<string, unknown>;
    const items = Array.isArray(obj['items']) ? obj['items'] : undefined;
    return {
      description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
      itemCount: items?.length,
    };
  } catch {
    return {};
  }
}

const resolveSwarmMembers =
  inject(ResolveSwarmMembersKey);

const input = computed(() => parseInput(props.tool.arg));
const label = computed(() => toolLabel(props.tool.name));
const description = computed(() => input.value.description ?? '');
const members = computed(() => resolveSwarmMembers?.(props.tool.id) ?? []);
const result = computed(() => parseSwarmResult(props.tool.output));

const modelDisplay = inject(ModelDisplayKey);
const subagentEffort = inject(SubagentEffortKey);
const swarmModelLabel = computed(() => {
  let label: string | undefined;
  for (const member of members.value) {
    const display = modelDisplay?.(member.model);
    const effort = subagentEffort?.(member.thinkingEffort);
    const parts = [display, effort].filter((part) => part !== undefined);
    if (parts.length === 0) continue;
    const current = parts.join(' · ');
    if (label === undefined) {
      label = current;
    } else if (label !== current) {
      return undefined;
    }
  }
  return label;
});
const swarmAgentType = computed(() => {
  const list = members.value;
  if (list.length === 0) return undefined;
  const first = list[0]?.subagentType;
  if (first === undefined) return undefined;
  return list.every((member) => member.subagentType === first) ? first : undefined;
});
const headerMeta = computed(() => [swarmAgentType.value, swarmModelLabel.value].filter(Boolean).join(' · '));

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const aggregateStatus = computed<'running' | 'ok' | 'error'>(() => {
  if (status.value === 'running') return 'running';
  if (status.value === 'error' || (result.value?.failed ?? 0) > 0) return 'error';
  return 'ok';
});

interface PhaseCounts {
  completed: number;
  working: number;
  suspended: number;
  queued: number;
  failed: number;
  cancelled: number;
}

const rows = computed<SwarmCardRow[]>(() => buildSwarmCardRows(members.value, result.value));

const counts = computed<PhaseCounts>(() => {
  const c: PhaseCounts = { completed: 0, working: 0, suspended: 0, queued: 0, failed: 0, cancelled: 0 };
  for (const r of rows.value) c[r.phase]++;
  return c;
});

const total = computed(() => Math.max(rows.value.length, input.value.itemCount ?? 0));
const done = computed(() => counts.value.completed + counts.value.failed + counts.value.cancelled);

const open = useHistoryState(`tool:${props.tool.id}:open`, true);
function toggle(): void {
  open.value = !open.value;
}

const fallbackOutput = computed(() => {
  if (rows.value.length > 0 || result.value) return '';
  if (status.value === 'running') return '';
  return (props.tool.output ?? []).join('\n').trim();
});

const openRows = useHistoryState<string[]>(`tool:${props.tool.id}:openRows`, []);

function panelTarget(row: SwarmCardRow): string | undefined {
  if (row.agentId !== undefined) return row.agentId;
  const live = row.phase === 'queued' || row.phase === 'working' || row.phase === 'suspended';
  return live ? row.taskId : undefined;
}

function canExpand(row: SwarmCardRow): boolean {
  if (panelTarget(row) !== undefined) return false;
  if (row.phase !== 'completed' && row.phase !== 'cancelled' && row.phase !== 'failed') return false;
  return row.detail.length > 0;
}

function isRowOpen(id: string): boolean {
  return openRows.value.includes(id);
}

function toggleRow(id: string): void {
  openRows.value = isRowOpen(id) ? openRows.value.filter((entry) => entry !== id) : [...openRows.value, id];
  void nextTick(updateMembersScrollState);
}

function isOperable(row: SwarmCardRow): boolean {
  return panelTarget(row) !== undefined || canExpand(row);
}

const HINT_MAX_CHARS = 400;

function clipHint(text: string, keepEnd: boolean): string {
  if (text.length <= HINT_MAX_CHARS) return text;
  return keepEnd
    ? `…${text.slice(-(HINT_MAX_CHARS - 1)).trimStart()}`
    : `${text.slice(0, HINT_MAX_CHARS - 1).trimEnd()}…`;
}

function errorDetail(row: SwarmCardRow): string {
  const detail = row.detail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  if (!detail) return row.activity;
  return clipHint(detail, !detail.startsWith(row.activity));
}

function pausedReason(row: SwarmCardRow): string {
  return rowStatus(row) === 'suspended' ? (row.suspendedReason?.trim() ?? '') : '';
}

function rowDescription(row: SwarmCardRow): string | undefined {
  if (rowStatus(row) === 'error' && errorDetail(row)) return errorDetail(row);
  if (pausedReason(row)) return pausedReason(row);
  if (panelTarget(row) !== undefined) return t('tasks.openDetail');
  return undefined;
}

function openMember(row: SwarmCardRow): void {
  const target = panelTarget(row);
  if (target !== undefined) {
    panelApi?.openAgent(target);
    return;
  }
  if (canExpand(row)) toggleRow(row.id);
}

const membersArea = ref<InstanceType<typeof ScrollArea> | null>(null);
const edgeTop = ref(false);
const edgeBottom = ref(false);

function updateMembersScrollState(): void {
  const el = membersArea.value?.viewport;
  edgeTop.value = el !== null && el !== undefined && el.scrollTop > 1;
  edgeBottom.value = el !== null && el !== undefined && el.scrollHeight - el.clientHeight - el.scrollTop > 1;
}

let detachMembersScroll: (() => void) | null = null;
watch(
  membersArea,
  (area) => {
    detachMembersScroll?.();
    detachMembersScroll = null;
    const el = area?.viewport ?? null;
    if (!el) return;
    el.addEventListener('scroll', updateMembersScrollState, { passive: true });
    const resize = new ResizeObserver(updateMembersScrollState);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    const mutations = new MutationObserver(updateMembersScrollState);
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    detachMembersScroll = () => {
      el.removeEventListener('scroll', updateMembersScrollState);
      resize.disconnect();
      mutations.disconnect();
    };
    updateMembersScrollState();
  },
  { immediate: true, flush: 'post' },
);
onBeforeUnmount(() => detachMembersScroll?.());

type RowStatus = 'running' | 'queued' | 'suspended' | 'error' | 'cancelled' | 'finished';

const ROW_STATUS_KEYS: Record<RowStatus, string> = {
  running: 'tools.swarm.phaseWorking',
  queued: 'tools.swarm.phaseQueued',
  suspended: 'tools.swarm.phaseSuspended',
  error: 'tools.swarm.phaseFailed',
  cancelled: 'tools.swarm.phaseCancelled',
  finished: 'tools.swarm.phaseCompleted',
};

function rowStatus(row: SwarmCardRow): RowStatus {
  if (row.phase === 'queued' || row.phase === 'suspended') return row.phase;
  if (row.phase === 'failed') return 'error';
  if (row.phase === 'cancelled') return 'cancelled';
  if (row.phase === 'completed') return 'finished';
  return 'running';
}

function statusLabel(status: RowStatus): string {
  return t(ROW_STATUS_KEYS[status]);
}

const ROW_STATUS_ICONS: Record<Exclude<RowStatus, 'running'>, string> = {
  queued: 'clock',
  suspended: 'pause',
  error: 'alert-triangle',
  cancelled: 'close',
  finished: 'circle-check',
};

function statusIcon(status: RowStatus): string | undefined {
  return status === 'running' ? undefined : ROW_STATUS_ICONS[status];
}
</script>

<template>
  <ToolDisclosure :status="aggregateStatus" :open="open" expandable @toggle="toggle">
    <template #leading><Icon name="sparkles" size="sm" /></template>
    <span class="tl-name">{{ label }}</span>
    <span v-if="description" class="tl-dim">{{ description }}</span>
    <span v-if="total > 0" class="tl-faint">{{ done }} / {{ total }}</span>
    <template #body>
      <div class="sw-content">
        <ToolPanel>
          <div class="sw-head">
            <span class="sw-avatar" aria-hidden="true"><Icon name="robot" size="lg" /></span>
            <span class="sw-text">
              <span class="sw-title">{{ description || label }}</span>
              <span v-if="headerMeta" class="sw-model">{{ headerMeta }}</span>
            </span>
            <span v-if="total > 0" class="sw-count">{{ done }} / {{ total }}</span>
          </div>
        </ToolPanel>

        <div v-if="rows.length > 0" class="sw-wrap">
          <ScrollArea ref="membersArea" class="sw-area" overscroll="auto">
            <div class="sw-members">
            <div v-for="(row, i) in rows" :key="row.id" class="sw-member">
              <component
                :is="isOperable(row) ? 'button' : 'div'"
                class="sw-row"
                :type="isOperable(row) ? 'button' : undefined"
                :aria-expanded="canExpand(row) ? isRowOpen(row.id) : undefined"
                :aria-description="rowDescription(row)"
                :title="statusLabel(rowStatus(row))"
                @click="openMember(row)"
              >
                <Tooltip :text="row.name">
                  <span class="sw-name">{{ row.name }}</span>
                </Tooltip>
                <span class="sw-tail">
                  <Tooltip v-if="rowStatus(row) === 'error'" :text="errorDetail(row) || statusLabel('error')" :max-lines="20">
                    <span
                      class="sw-state sw-err"
                      :tabindex="isOperable(row) ? undefined : 0"
                      :role="isOperable(row) ? undefined : 'note'"
                      :aria-label="isOperable(row) ? undefined : errorDetail(row) || statusLabel('error')"
                    >
                      <Icon name="alert-triangle" size="sm" aria-hidden="true" />
                      <span>{{ statusLabel('error') }}</span>
                    </span>
                  </Tooltip>
                  <Tooltip v-else-if="pausedReason(row)" :text="pausedReason(row)" :max-lines="20">
                    <span class="sw-state sw-paused">
                      <Icon name="pause" size="sm" aria-hidden="true" />
                      <span>{{ statusLabel('suspended') }}</span>
                    </span>
                  </Tooltip>
                  <span v-else class="sw-state">
                    <Spinner v-if="rowStatus(row) === 'running'" class="sw-spin" size="sm" />
                    <Icon v-else :name="statusIcon(rowStatus(row))!" size="sm" aria-hidden="true" />
                    <span>{{ statusLabel(rowStatus(row)) }}</span>
                  </span>
                  <span class="sw-idx">{{ String(i + 1).padStart(2, '0') }}</span>
                  <Icon
                    class="sw-go"
                    :class="{ 'sw-go-off': !isOperable(row), 'sw-go-open': canExpand(row) && isRowOpen(row.id) }"
                    name="chevron-right"
                    size="sm"
                    aria-hidden="true"
                  />
                </span>
              </component>
              <div v-if="canExpand(row)" v-show="isRowOpen(row.id)" class="sw-body">{{ row.detail }}</div>
            </div>
            </div>
          </ScrollArea>
          <div
            class="sw-edges"
            :style="{ '--sw-edge-top': edgeTop ? 1 : 0, '--sw-edge-bottom': edgeBottom ? 1 : 0 }"
            aria-hidden="true"
          />
        </div>

        <div v-else-if="fallbackOutput" class="sw-fallback">{{ fallbackOutput }}</div>
        <div v-else-if="status === 'running'" class="sw-waiting">{{ t('tools.swarm.waiting') }}</div>
      </div>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.sw-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.sw-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
}
.sw-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--color-fill-1);
  color: var(--color-text);
}
.sw-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.sw-title {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sw-model {
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sw-count {
  flex: none;
  color: var(--color-accent);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}

.sw-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-height: 300px;
}
.sw-area {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  --ui-scroll-area-track-inset: var(--radius-lg);
}
.sw-members {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: var(--space-1);
}

@property --sw-edge-top {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}
@property --sw-edge-bottom {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}
.sw-edges {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  pointer-events: none;
  transition:
    --sw-edge-top var(--duration-slow) var(--ease-out),
    --sw-edge-bottom var(--duration-slow) var(--ease-out);
  mask-image:
    linear-gradient(to bottom, rgb(0 0 0 / var(--sw-edge-top)), transparent var(--chat-scroll-edge-size)),
    linear-gradient(to top, rgb(0 0 0 / var(--sw-edge-bottom)), transparent var(--chat-scroll-edge-size));
}
.sw-edges::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow:
    inset 0 0 calc(var(--chat-scroll-edge-size) * 0.35) var(--color-chat-scroll-edge-strong),
    inset 0 0 calc(var(--chat-scroll-edge-size) * 0.65) var(--color-chat-scroll-edge-medium),
    inset 0 0 var(--chat-scroll-edge-size) var(--color-chat-scroll-edge-soft);
  mask-image:
    linear-gradient(to bottom, rgb(0 0 0 / var(--sw-edge-top)), black var(--chat-scroll-edge-size)),
    linear-gradient(to top, rgb(0 0 0 / var(--sw-edge-bottom)), black var(--chat-scroll-edge-size));
  mask-composite: intersect;
}

@media (prefers-reduced-motion: reduce) {
  .sw-edges,
  .sw-go {
    transition: none;
  }
}
.sw-member {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sw-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  cursor: pointer;
}
button.sw-row:hover {
  background: var(--color-hover);
}
div.sw-row {
  cursor: default;
}
.sw-row:focus-visible,
.sw-err:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}
.sw-name {
  display: block;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text);
  white-space: nowrap;
}
.sw-tail {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.sw-state {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: var(--space-1);
  color: var(--color-text-faint);
}
.sw-err {
  color: var(--color-danger);
}
.sw-tail .sw-spin {
  color: var(--color-text-faint);
}
.sw-go-off {
  visibility: hidden;
}
.sw-go-open {
  transform: rotate(90deg);
}
.sw-idx {
  min-width: 20px;
  text-align: right;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.sw-go {
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}

.sw-body {
  margin: 0 var(--space-2) var(--space-1);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--content-font-size);
  line-height: 1.571;
  white-space: pre-wrap;
  word-break: break-word;
}

.sw-fallback {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--content-font-size);
  line-height: 1.571;
  white-space: pre-wrap;
  word-break: break-word;
}
.sw-waiting {
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
</style>
