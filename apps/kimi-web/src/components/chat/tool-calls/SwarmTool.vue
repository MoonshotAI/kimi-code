<!-- apps/kimi-web/src/components/chat/tool-calls/SwarmTool.vue -->
<!-- A single AgentSwarm tool call, rendered as one inline "operation card".
     Expanded by default while the swarm runs, collapsed once settled; when
     opened the body shows a phase overview and a phase overview and a
     per-member accordion — each subagent is a collapsible row (state dot +
     name + one-line activity + phase) that expands on its own to reveal the
     full output. While the swarm runs the rows come from the AppTask store
     (`resolveSwarmMembers`); after the tool result lands — and after a refresh
     drops the live tasks — the same rows come from the parsed
     `<agent_swarm_result>` payload. See §04 tool-calls. -->
<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FilePreviewRequest, ToolCall, ToolMedia } from '../../../types';
import type { AppSubagentPhase } from '../../../api/types';
import type { SwarmMember } from '../../../composables/swarmGroups';
import { toolLabel } from '../../../lib/toolMeta';
import { parseSwarmResult } from '../../../lib/parseSwarmResult';
import { buildSwarmCardRows, type SwarmCardRow } from '../../../lib/swarmCardRows';
import Icon from '../../ui/Icon.vue';
import StatusDot from '../../ui/StatusDot.vue';
import Tooltip from '../../ui/Tooltip.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
    toolDiffPanel?: boolean;
  }>(),
  { mobile: false, stackPosition: 'single', toolDiffPanel: false },
);

defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openToolDiff: [id: string];
  openAgent: [toolCallId: string];
}>();

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
  inject<(toolCallId: string) => SwarmMember[] | undefined>('resolveSwarmMembers');

const input = computed(() => parseInput(props.tool.arg));
const label = computed(() => toolLabel(props.tool.name));
const description = computed(() => input.value.description ?? '');
const members = computed(() => resolveSwarmMembers?.(props.tool.id) ?? []);
const result = computed(() => parseSwarmResult(props.tool.output));

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const aggregateStatus = computed<'running' | 'ok' | 'error'>(() => {
  if (status.value === 'running') return 'running';
  if (status.value === 'error' || (result.value?.failed ?? 0) > 0 || (result.value?.aborted ?? 0) > 0)
    return 'error';
  return 'ok';
});

interface PhaseCounts {
  completed: number;
  working: number;
  suspended: number;
  queued: number;
  failed: number;
}

// Rows are the single source of truth: phase counts and totals derive from the
// live members and any not-yet-spawned result entries merged together (see
// buildSwarmCardRows). Without that merge an interrupted swarm could drop
// `state="not_started"` / `outcome="aborted"` rows when at least one live
// AppTask still exists.
const rows = computed<SwarmCardRow[]>(() => buildSwarmCardRows(members.value, result.value));

const counts = computed<PhaseCounts>(() => {
  const c: PhaseCounts = { completed: 0, working: 0, suspended: 0, queued: 0, failed: 0 };
  for (const r of rows.value) c[r.phase]++;
  return c;
});

const total = computed(() => rows.value.length || input.value.itemCount || 0);
const done = computed(() => counts.value.completed + counts.value.failed);
const inProgress = computed(() => counts.value.working + counts.value.suspended + counts.value.queued);

const PHASE_ORDER: readonly { phase: AppSubagentPhase; cls: string }[] = [
  { phase: 'completed', cls: 's-ok' },
  { phase: 'working', cls: 's-run' },
  { phase: 'suspended', cls: 's-warn' },
  { phase: 'failed', cls: 's-fail' },
  { phase: 'queued', cls: 's-queue' },
];

interface Segment {
  phase: AppSubagentPhase;
  count: number;
  cls: string;
}

const segments = computed<Segment[]>(() =>
  PHASE_ORDER.map(({ phase, cls }) => ({ phase, count: counts.value[phase], cls })).filter(
    (s) => s.count > 0,
  ),
);

// Running swarms start expanded so live progress is visible without a click;
// settled cards (history, finished runs) stay collapsed — §04 tool rows
// expand on demand. The default applies only at mount; manual toggles stick.
const open = ref(status.value === 'running' || inProgress.value > 0);
function toggle(): void {
  open.value = !open.value;
}

// When AgentSwarm produces no structured result but the tool is no longer
// running — e.g. argument validation bailing before renderSwarmResults, or an
// unrecognized legacy output — show the raw tool output instead of the
// "waiting" placeholder so the user sees the final text / failure cause.
const fallbackOutput = computed(() => {
  if (rows.value.length > 0 || result.value) return '';
  if (status.value === 'running') return '';
  return (props.tool.output ?? []).join('\n').trim();
});

// Per-row accordion: each member expands on its own, leaving the rest folded.
const openRows = ref<Set<string>>(new Set());
function toggleRow(id: string): void {
  const next = new Set(openRows.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openRows.value = next;
}
function isRowOpen(id: string): boolean {
  return openRows.value.has(id);
}

function phaseLabel(phase: AppSubagentPhase): string {
  return t(`tools.swarm.phase${phase[0]!.toUpperCase()}${phase.slice(1)}`);
}
</script>

<template>
  <div class="swarm-card" :class="{ open, err: aggregateStatus === 'error', stacked: stackPosition !== 'single' }">
    <button class="head" type="button" :aria-expanded="open" @click="toggle">
      <Icon class="ic" name="git-pull-request" size="sm" />
      <span class="title">{{ label }}</span>
      <span v-if="description" class="meta">·</span>
      <span v-if="description" class="sum-txt">{{ description }}</span>
      <span class="rt">
        <span class="status">
          <Icon v-if="aggregateStatus === 'ok'" name="check" size="sm" />
          <Icon v-else-if="aggregateStatus === 'error'" name="close" size="sm" />
          <StatusDot v-else status="running" />
        </span>
        <span v-if="done > 0 || total > 0" class="chip">{{ done }} / {{ total }}</span>
        <span v-if="tool.timing" class="tm">{{ tool.timing }}</span>
      </span>
      <Icon class="car" :name="open ? 'chevron-down' : 'chevron-right'" size="sm" />
    </button>

    <div v-show="open" class="body">
      <div class="overview">
        <div class="overview-line">
          <span class="big">{{ t('tools.swarm.progress', { done, total }) }}</span>
          <span v-if="aggregateStatus === 'running' && total > 0" class="lbl">
            {{ t('tools.swarm.runningSub', { count: inProgress }) }}
          </span>
          <span v-else-if="result" class="lbl">
            {{ t('tools.swarm.doneSub', { completed: result.completed, failed: result.failed + result.aborted }) }}
          </span>
          <span v-else class="lbl">{{ t('tools.swarm.waiting') }}</span>
        </div>
        <div v-if="total > 0 && segments.length > 0" class="seg" aria-hidden="true">
          <span v-for="s in segments" :key="s.phase" :class="s.cls" :style="{ flex: s.count }" />
        </div>
        <div v-if="segments.length > 1" class="legend">
          <span v-for="s in segments" :key="s.phase">
            <i class="lg-dot" :class="s.cls" />{{ phaseLabel(s.phase) }} {{ s.count }}
          </span>
        </div>
      </div>

      <template v-if="rows.length > 0">
        <div
          v-for="row in rows"
          :key="row.id"
          class="member"
          :class="[`phase-${row.phase}`, { open: isRowOpen(row.id) }]"
        >
          <button
            class="member-head"
            type="button"
            :aria-expanded="isRowOpen(row.id)"
            @click="toggleRow(row.id)"
          >
            <StatusDot class="row-dot" :status="row.phase" />
            <Tooltip :text="row.name">
              <span class="mname">{{ row.name }}</span>
            </Tooltip>
            <Tooltip v-if="row.activity" :text="row.activity">
              <span class="mact">{{ row.activity }}</span>
            </Tooltip>
            <span class="mphase">{{ phaseLabel(row.phase) }}</span>
            <Icon class="mcar" :name="isRowOpen(row.id) ? 'chevron-down' : 'chevron-right'" size="sm" />
          </button>
          <div v-show="isRowOpen(row.id)" class="member-body">{{ row.body }}</div>
        </div>
      </template>

      <div v-else-if="fallbackOutput" class="fallback-output">{{ fallbackOutput }}</div>

      <div v-else class="waiting">{{ t('tools.swarm.waiting') }}</div>
    </div>
  </div>
</template>

<style scoped>
.swarm-card {
  margin: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: border-color var(--duration-base) var(--ease-out);
}
.swarm-card.err {
  border-color: color-mix(in srgb, var(--color-danger) 25%, var(--bg));
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 0 11px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.head:hover,
.swarm-card.open > .head {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.swarm-card.err > .head {
  background: color-mix(in srgb, var(--color-danger) 4%, var(--bg));
}
.swarm-card.err > .head:hover {
  background: color-mix(in srgb, var(--color-danger) 7%, var(--bg));
}
.head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}
.ic {
  color: var(--color-text-faint);
  flex: none;
}
.title {
  font-weight: var(--weight-medium);
  color: var(--color-text);
  flex: none;
}
.meta {
  color: var(--color-text-faint);
  flex: none;
}
.sum-txt {
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.rt {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.status {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.status:has(> svg) {
  color: var(--color-success);
}
.err .status:has(> svg) {
  color: var(--color-danger);
}
.chip {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}
.tm {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
}
.car {
  margin-left: 2px;
  color: var(--color-text-faint);
  flex: none;
}

.body {
  border-top: 1px solid var(--color-line);
  background: var(--color-surface-sunken);
}

/* Overview strip: count + segmented phase bar + legend. */
.overview {
  padding: 9px 11px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-line) 70%, transparent);
}
.overview-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.big {
  font-family: var(--font-mono);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  font-size: 15px;
}
.lbl {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.seg {
  display: flex;
  height: 5px;
  border-radius: var(--radius-full);
  overflow: hidden;
  margin: 8px 0 4px;
  gap: 2px;
}
.seg > span {
  height: 100%;
  border-radius: var(--radius-full);
  min-width: 3px;
}
.s-ok { background: var(--color-success); }
.s-run { background: var(--color-accent); }
.s-warn { background: var(--color-warning); }
.s-fail { background: var(--color-danger); }
.s-queue { background: var(--color-line); }
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
}
.lg-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
}

/* Per-member accordion. */
.member {
  border-bottom: 1px solid color-mix(in srgb, var(--color-line) 70%, transparent);
}
.member:last-child {
  border-bottom: none;
}
.member-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 0 11px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.member-head:hover,
.member.open .member-head {
  background: color-mix(in srgb, var(--color-surface) 55%, var(--bg));
}
.member-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}
.row-dot {
  flex: none;
}
.mname {
  flex: none;
  min-width: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.mact {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.mphase {
  flex: none;
  margin-left: auto;
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-faint);
}
.phase-completed .mphase { color: var(--color-success); }
.phase-failed .mphase { color: var(--color-danger); }
.phase-working .mphase { color: var(--color-accent); }
.phase-suspended .mphase { color: var(--color-warning); }
.mcar {
  margin-left: 4px;
  color: var(--color-text-faint);
  flex: none;
}
.member-body {
  padding: 4px 11px 10px 31px;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.waiting {
  padding: 6px 11px 10px;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.fallback-output {
  padding: 9px 11px 10px;
  color: var(--color-text);
  font: var(--text-xs)/1.6 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
