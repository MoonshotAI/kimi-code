<!-- Background subagents as the swarm card grid (the redesign): name + index,
     the prompt as description, and a status row with timing. Click a card to
     open the agent's live detail; running cards offer cancel on hover. -->
<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import { Icon, IconButton, StatusDot } from '@moonshot-ai/app-ui';
import { ModelDisplayKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { formatDuration } from '@moonshot-ai/app-components';

const props = defineProps<{ tasks: TaskItem[]; filter?: 'active' | 'running' | 'done' | 'all' }>();
const EMPTY_KEYS = {
  active: 'tasks.emptyRecent',
  running: 'tasks.emptyRunning',
  done: 'tasks.emptyDone',
  all: 'tasks.emptyTasks',
} as const;
// The empty text follows the filter: an empty "done" view must not claim
// there is no background work.
const emptyKey = computed(() => EMPTY_KEYS[props.filter ?? 'all']);


const emit = defineEmits<{
  open: [taskId: string];
  cancel: [taskId: string];
}>();

const { t } = useI18n();

// The bound model + thinking effort, shared by every subagent surface (the
// Agent tool card, swarm rows, the detail panel) — the card carries it too.
const modelDisplay = inject(ModelDisplayKey);
const subagentEffort = inject(SubagentEffortKey);
function modelEffortLabel(task: TaskItem): string | undefined {
  const parts = [modelDisplay?.(task.model), subagentEffort?.(task.thinkingEffort)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function stateLabel(state: string): string {
  if (state === 'done') return t('tasks.stateDone');
  if (state === 'fail') return t('tasks.stateFail');
  if (state === 'cancelled') return t('tasks.stateCancelled');
  return t('tasks.running');
}

// Bare duration on the right — the state word on the left already says it.
// Without a computable duration show nothing: the raw protocol status word
// (completed/failed/cancelled) is not a duration and reads as stray English.
function durationLabel(task: TaskItem): string {
  if (typeof task.durationMs !== 'number') return '';
  return formatDuration(task.durationMs, {
    h: t('status.timeUnitHour'),
    m: t('status.timeUnitMinute'),
    s: t('status.timeUnitSecond'),
  });
}

/** Card number: the session-wide serial assigned upstream (see the tasks
    computed) — unique across swarms, and filtering never renumbers an
    agent. */
function num(task: TaskItem, i: number): string {
  return String((task.swarmIndex ?? i) + 1).padStart(2, '0');
}

/** Opening fetches an on-demand transcript keyed by the stable child-agent
    id; a REST-only row (cold load, not yet merged with WS/snapshot) has
    neither that id nor any displayable detail — opening would show an
    empty panel, so keep the card inert until one of the two arrives. */
function canOpen(task: TaskItem): boolean {
  return Boolean(task.agentId) || Boolean(task.output && task.output.length > 0);
}
</script>

<template>
  <div v-if="tasks.length === 0" class="sg-empty">{{ t(emptyKey) }}</div>
  <div v-else class="sg-grid">
    <div
      v-for="(task, i) in tasks"
      :key="task.id"
      class="sg-card"
      :class="[`s-${task.state}`, { openable: canOpen(task) }]"
    >
      <!-- Open and cancel are SIBLING controls: a full-cover overlay button
           opens the detail (natively focusable + Enter/Space), the cancel
           IconButton floats above it. No nested interactives. -->
      <button
        v-if="canOpen(task)"
        type="button"
        class="sg-open"
        :aria-label="task.name"
        @click="emit('open', task.agentId ?? task.id)"
      />
      <div class="sg-top">
        <span class="sg-num">{{ num(task, i) }}</span>
        <span class="sg-name">{{ task.name }}</span>
      </div>
      <div v-if="task.meta" class="sg-desc">{{ task.meta }}</div>
      <div class="sg-foot">
        <div v-if="modelEffortLabel(task)" class="sg-model">
          <Icon name="robot" size="sm" /><span>{{ modelEffortLabel(task) }}</span>
        </div>
        <div class="sg-status">
          <span class="sg-state">
            <StatusDot v-if="task.state === 'run'" status="running" />
            <Icon v-else-if="task.state === 'done'" class="sg-ic-done" name="circle-check" size="sm" />
            <Icon v-else name="close" size="sm" />
            {{ stateLabel(task.state) }}
          </span>
          <span v-if="durationLabel(task)" class="sg-time"><Icon name="clock" size="sm" />{{ durationLabel(task) }}</span>
        </div>
      </div>
      <IconButton
        v-if="task.state === 'run'"
        class="sg-cancel"
        size="sm"
        :label="t('tasks.stop')"
        :tooltip="t('tasks.stop')"
        @click.stop="emit('cancel', task.id)"
      >
        <Icon name="close" size="sm" />
      </IconButton>
    </div>
  </div>
</template>

<style scoped>
.sg-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  user-select: none;
}
.sg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--p-subagent-card-min), 1fr));
  gap: var(--space-2);
}
.sg-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--color-selected);
}
/* Pointer affordance only when the card actually opens (canOpen). */
.sg-card.openable {
  cursor: pointer;
}
.sg-card.openable:hover {
  background: var(--color-selected-hover);
}
/* Cards that can't open (no agentId and no output yet) say so on hover. */
.sg-card:not(.openable) {
  cursor: not-allowed;
}
/* The open overlay covers the card; the cancel floats above it. */
.sg-open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: pointer;
}
.sg-open:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.sg-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sg-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.sg-num {
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
/* Running cards reserve the cancel's corner zone so the number is never
   covered — the button box plus a --space-1 margin; wider on touch, where
   the touch-target cancel is always visible. */
.sg-card:has(.sg-cancel) .sg-top {
  padding-right: calc(var(--icon-button-sm) + var(--space-1));
}
@media (hover: none) {
  .sg-card:has(.sg-cancel) .sg-top {
    padding-right: calc(var(--touch-target-min) + var(--space-1));
  }
}
.sg-desc {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-caption);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sg-foot {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* Model · effort gets its own icon-led line, tight against the status row. */
.sg-model {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.sg-model span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sg-status {
  display: flex;
  align-items: center;
}
.sg-state {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-autospace: normal;
}
.sg-ic-done {
  color: var(--color-success);
  /* circle-check is drawn full-bleed for the todo rows' ring family;
   scaled onto the shared 24-grid here so it matches the sibling glyphs. */
  transform: scale(0.91);
}
.s-fail .sg-state { color: var(--color-danger); }
.sg-time {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  text-autospace: normal;
}
.sg-cancel {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.sg-card:hover .sg-cancel,
.sg-cancel:focus-visible {
  opacity: 1;
}
.sg-cancel:hover {
  color: var(--color-danger);
}
/* Touch (no hover): the cancel must be always visible — an invisible button
   that still hit-tests is an accidental-cancel trap — with a 44px target in
   the card's corner; the glyph itself is unchanged. */
@media (hover: none) {
  .sg-cancel {
    top: 0;
    right: 0;
    width: var(--touch-target-min);
    height: var(--touch-target-min);
    opacity: 1;
  }
}
</style>
