<!-- A single AgentSwarm tool call, rendered as one inline "operation card".
     Expanded by default while the swarm runs, collapsed once settled; when
     opened the body shows a phase overview and one row per member. Rows with a
     stable agent id open a resumable transcript; legacy result-only rows keep
     their saved output inline. While the swarm runs the rows come from the
     AppTask store
     (`resolveSwarmMembers`); after the tool result lands — and after a refresh
     drops the live tasks — the same rows come from the parsed
     `<agent_swarm_result>` payload. See §04 tool-calls. -->
<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FilePreviewRequest, OpenMediaRequest, ToolCall } from '@moonshot-ai/app-core/client/types';
import type { AppSubagentPhase } from '@moonshot-ai/app-core/api';
import { ModelDisplayKey, ResolveSwarmMembersKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { toolLabel } from '@moonshot-ai/app-components';
import { parseSwarmResult } from '@moonshot-ai/app-core/lib';
import { buildSwarmCardRows, type SwarmCardRow } from '@moonshot-ai/app-core/client';
import { Icon, StatusDot, Tooltip } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  openFile: [target: FilePreviewRequest];
  openAgent: [agentId: string];
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
  inject(ResolveSwarmMembersKey);

const input = computed(() => parseInput(props.tool.arg));
const label = computed(() => toolLabel(props.tool.name));
const description = computed(() => input.value.description ?? '');
const members = computed(() => resolveSwarmMembers?.(props.tool.id) ?? []);
const result = computed(() => parseSwarmResult(props.tool.output));

// Swarm members normally share one binding, so the card shows the bound model
// once in the overview line, with the effort appended whenever a concrete
// level exists — but only when every reporting member agrees: a mixed swarm
// (resumed members keep their own bindings) gets no single label rather than
// the first member's. A member reports with whichever of model/effort it has
// (an effort-only member still counts). Result-only rows after a refresh
// carry neither and simply hide it.
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

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const aggregateStatus = computed<'running' | 'ok' | 'error'>(() => {
  if (status.value === 'running') return 'running';
  // Aborted is a user stop (cancelled rows) — it never makes the card an error.
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

// Rows are the single source of truth: phase counts and totals derive from the
// live members and any not-yet-spawned result entries merged together (see
// buildSwarmCardRows). Without that merge an interrupted swarm could drop
// `state="not_started"` / `outcome="aborted"` rows when at least one live
// AppTask still exists.
const rows = computed<SwarmCardRow[]>(() => buildSwarmCardRows(members.value, result.value));

const counts = computed<PhaseCounts>(() => {
  const c: PhaseCounts = { completed: 0, working: 0, suspended: 0, queued: 0, failed: 0, cancelled: 0 };
  for (const r of rows.value) c[r.phase]++;
  return c;
});

const total = computed(() => rows.value.length || input.value.itemCount || 0);
const done = computed(() => counts.value.completed + counts.value.failed + counts.value.cancelled);
// A user stop gets its own count in the summary instead of inflating failures.
const doneSubLabel = computed(() => {
  const r = result.value;
  if (!r) return '';
  const cancelled = r.aborted ?? 0;
  return cancelled > 0
    ? t('tools.swarm.doneSubWithCancelled', { completed: r.completed, failed: r.failed, cancelled })
    : t('tools.swarm.doneSub', { completed: r.completed, failed: r.failed });
});
const inProgress = computed(() => counts.value.working + counts.value.suspended + counts.value.queued);

const PHASE_ORDER: readonly { phase: AppSubagentPhase; cls: string }[] = [
  { phase: 'completed', cls: 's-ok' },
  { phase: 'working', cls: 's-run' },
  { phase: 'suspended', cls: 's-warn' },
  { phase: 'failed', cls: 's-fail' },
  // A user stop is neutral — the muted queued styling, never the danger one.
  { phase: 'cancelled', cls: 's-queue' },
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

const openRows = ref<Set<string>>(new Set());

function isRowOpen(id: string): boolean {
  return openRows.value.has(id);
}

function toggleRowBody(id: string): void {
  const next = new Set(openRows.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openRows.value = next;
}

function openMember(row: SwarmCardRow): void {
  if (row.agentId) {
    emit('openAgent', row.agentId);
    return;
  }
  if (!row.body) return;
  toggleRowBody(row.id);
}

function hasSavedBody(row: SwarmCardRow): boolean {
  return (
    row.agentId !== undefined &&
    row.body.length > 0 &&
    (row.phase === 'completed' || row.phase === 'failed' || row.phase === 'cancelled')
  );
}

function phaseLabel(phase: AppSubagentPhase): string {
  return t(`tools.swarm.phase${phase[0]!.toUpperCase()}${phase.slice(1)}`);
}
</script>

<template>
  <div class="swarm-card" :class="{ open, err: aggregateStatus === 'error' }">
    <button class="head" type="button" :aria-expanded="open" @click="toggle">
      <Icon class="ic" name="sparkles" size="sm" />
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
      <Icon class="car" name="chevron-right" size="sm" />
    </button>

    <div v-show="open" class="body">
      <div class="overview">
        <div class="overview-line">
          <span class="big">{{ t('tools.swarm.progress', { done, total }) }}</span>
          <span v-if="swarmModelLabel" class="lbl">{{ swarmModelLabel }}</span>
          <span v-if="aggregateStatus === 'running' && total > 0" class="lbl">
            {{ t('tools.swarm.runningSub', { count: inProgress }) }}
          </span>
          <span v-else-if="result" class="lbl">
            {{ doneSubLabel }}
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
          :class="[`phase-${row.phase}`, { open: !row.agentId && isRowOpen(row.id) }]"
        >
          <button
            class="member-head"
            type="button"
            :disabled="!row.agentId && !row.body"
            :aria-label="row.agentId ? t('tasks.openDetail') : undefined"
            :aria-expanded="!row.agentId && row.body ? isRowOpen(row.id) : undefined"
            @click="openMember(row)"
          >
            <StatusDot class="row-dot" :status="row.phase" />
            <Tooltip :text="row.name">
              <span class="mname">{{ row.name }}</span>
            </Tooltip>
            <Tooltip v-if="row.activity" :text="row.activity">
              <span class="mact">{{ row.activity }}</span>
            </Tooltip>
            <span class="mphase">{{ phaseLabel(row.phase) }}</span>
            <Icon v-if="row.agentId" class="mcar" name="arrow-right" size="sm" />
            <Icon v-else-if="row.body" class="mcar" name="chevron-right" size="sm" />
          </button>
          <button
            v-if="hasSavedBody(row)"
            class="member-saved"
            type="button"
            :aria-expanded="isRowOpen(row.id)"
            @click="toggleRowBody(row.id)"
          >
            <Icon
              class="member-saved-car"
              :class="{ open: isRowOpen(row.id) }"
              name="chevron-right"
              size="sm"
              aria-hidden="true"
            />
            <span>{{ t('tools.output.saved') }}</span>
          </button>
          <div
            v-if="row.body && (!row.agentId || hasSavedBody(row))"
            v-show="isRowOpen(row.id)"
            class="member-body"
          >
            {{ row.body }}
          </div>
        </div>
      </template>

      <div v-else-if="fallbackOutput" class="fallback-output">{{ fallbackOutput }}</div>

      <div v-else class="waiting">{{ t('tools.swarm.waiting') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* The swarm is the one heavy composite card in the stream (phase overview +
   member accordion), so it keeps a real container — but a quiet one: raised
   surface, hairline edge, large radius, no fill on the head. */
.swarm-card {
  margin: 0;
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color var(--duration-base) var(--ease-out);
}
.swarm-card.err {
  border-color: color-mix(in srgb, var(--color-danger) 45%, var(--bg));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 34px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.head:hover {
  background: var(--color-hover);
  color: var(--color-text);
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
  gap: var(--space-2);
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
  transition: transform var(--duration-base) var(--ease-out);
}
.swarm-card.open .car {
  transform: rotate(90deg);
}

.body {
  border-top: 0.5px solid var(--color-line);
}

/* Overview strip: count + segmented phase bar + legend. */
.overview {
  padding: 10px var(--space-3) var(--space-2);
  border-bottom: 0.5px solid var(--color-line);
}
.overview-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
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
  margin: var(--space-2) 0 var(--space-1);
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
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.lg-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
}

/* Per-member detail links and legacy result fallback. */
.member {
  border-bottom: 0.5px solid var(--color-line);
}
.member:last-child {
  border-bottom: none;
}
.member-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.member-head:not(:disabled):hover {
  background: var(--color-hover);
}
.member-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}
.member-head:disabled {
  cursor: default;
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
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.phase-completed .mphase { color: var(--color-success); }
.phase-failed .mphase { color: var(--color-danger); }
.phase-working .mphase { color: var(--color-accent); }
.phase-suspended .mphase { color: var(--color-warning); }
.mcar {
  margin-left: var(--space-1);
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.member.open .mcar {
  transform: rotate(90deg);
}
.member-saved {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-3);
  border: none;
  border-top: 0.5px solid var(--color-line);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}
.member-saved:hover {
  color: var(--color-text-muted);
}
.member-saved:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.member-saved-car {
  transition: transform var(--duration-base) var(--ease-out);
}
.member-saved-car.open {
  transform: rotate(90deg);
}
.member-body {
  padding: var(--space-1) var(--space-3) 10px 31px;
  color: var(--color-text-muted);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.waiting {
  padding: 6px var(--space-3) 10px;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.fallback-output {
  padding: 10px var(--space-3);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
