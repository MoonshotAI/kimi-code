<!-- Background bash tasks in the dock panel: long rows — a status dot, the
     name, the elapsed time, and stop for running ones. Click a row to open
     the task's detail (command + output) in the right-side panel. -->
<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import { Icon, IconButton, StatusDot } from '@moonshot-ai/app-ui';
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
  cancel: [taskId: string];
  /** A row was clicked — open the task's detail in the right-side panel. */
  open: [taskId: string];
}>();

const { t } = useI18n();

function hasDetail(task: TaskItem): boolean {
  return Boolean((task.output && task.output.length > 0) || task.meta);
}

function handleClick(task: TaskItem): void {
  if (!isClickable(task)) return;
  // Subagents open via the stable child-agent id (addresses an on-demand
  // transcript when one exists); everything else resolves as a live task id.
  emit('open', task.agentId ?? task.id);
}

function isClickable(task: TaskItem): boolean {
  return task.kind === 'subagent' || hasDetail(task);
}

// Bare duration on the right — the status dot on the left already says it.
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

/** Spoken state for the glyph (the dot/icons are aria-hidden shapes). */
function stateLabel(task: TaskItem): string {
  if (task.state === 'done') return t('tasks.stateDone');
  if (task.state === 'fail') return t('tasks.stateFail');
  if (task.state === 'cancelled') return t('tasks.stateCancelled');
  return t('tasks.running');
}

// Subagent rows show the bound model (friendly name) after the name; absent
// for rows restored without lifecycle metadata. The effort appears whenever a
// concrete level exists.
const modelDisplay = inject<(alias: string | undefined) => string | undefined>('modelDisplay');
const subagentEffort = inject<(effort: string | undefined) => string | undefined>('subagentEffort');
function taskModel(task: TaskItem): string | undefined {
  if (task.kind !== 'subagent') return undefined;
  return modelDisplay?.(task.model);
}
function taskEffort(task: TaskItem): string | undefined {
  if (task.kind !== 'subagent') return undefined;
  return subagentEffort?.(task.thinkingEffort);
}
</script>

<template>
  <div class="taskspane">
    <div class="tp-list">
      <div v-if="tasks.length === 0" class="tp-empty">{{ t(emptyKey) }}</div>

      <template v-else>
        <div
          v-for="task in tasks"
          :key="task.id"
          class="tp-row"
          :class="{ fail: task.state === 'fail', expandable: isClickable(task) }"
        >
          <div class="tp-main">
            <!-- Open and stop are SIBLING controls (same pattern as the
                 subagent card): an overlay button opens the detail, the stop
                 IconButton floats above it — no nested interactives. -->
            <button
              v-if="isClickable(task)"
              type="button"
              class="tp-open"
              :aria-label="task.name"
              @click="handleClick(task)"
            />
            <span class="tp-glyph" role="img" :aria-label="stateLabel(task)">
              <StatusDot v-if="task.state === 'run'" status="running" />
              <Icon v-else-if="task.state === 'done'" class="tp-done" name="circle-check" size="sm" />
              <Icon v-else-if="task.state === 'cancelled'" class="tp-cancelled" name="close" size="sm" />
              <Icon v-else class="tp-fail" name="close" size="sm" />
            </span>
            <span class="tp-name">{{ task.name }}</span>
            <span v-if="task.meta" class="tp-meta">{{ task.meta }}</span>
            <span v-if="taskModel(task)" class="tp-model">{{ taskModel(task) }}</span>
            <span v-if="taskEffort(task)" class="tp-model">{{ taskEffort(task) }}</span>
            <span v-if="durationLabel(task)" class="tp-time">{{ durationLabel(task) }}</span>
            <IconButton
              v-if="task.state === 'run'"
              class="tp-stop"
              size="sm"
              :label="t('tasks.stop')"
              :tooltip="t('tasks.stop')"
              @click.stop="emit('cancel', task.id)"
            >
              <Icon name="close" size="sm" />
            </IconButton>
            <Icon v-if="isClickable(task)" class="tp-chevron" name="chevron-right" size="sm" />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.taskspane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* List: no cards, just clean rows. Shows ALL tasks and scrolls internally once
   they overflow the pane (no "+N more" cap) so nothing is silently hidden. */
.tp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-05);
}

.tp-row {
  padding: var(--space-1) 0;
}
.tp-row.fail .tp-name {
  color: var(--color-danger);
}

.tp-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-base);
}
.tp-row.expandable > .tp-main {
  position: relative;
  border-radius: var(--radius-lg);
  /* Bigger hover strip at the same row metrics: padding grows the
     background, the matching negative margin keeps the box size. (No
     horizontal margin — that overflows the scroll container.) */
  padding: var(--space-1) var(--space-2);
  margin: calc(-1 * var(--space-1)) 0;
}
.tp-row.expandable > .tp-main:hover {
  background: var(--color-hover);
}
/* Rows with nothing to open (isClickable false) say so on hover. */
.tp-row:not(.expandable) {
  cursor: not-allowed;
}
/* The open overlay covers the row; the stop floats above it. */
.tp-open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: pointer;
}
.tp-open:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tp-chevron {
  flex: none;
  color: var(--muted);
}

.tp-name {
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The recovered command summary rides inline, muted, and truncates first. */
.tp-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

/* Terminal states get shapes, not just colours: ✓ for done, × for failed —
   the running pulse stays a dot. */
.tp-glyph {
  flex: none;
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tp-done {
  color: var(--color-success);
  /* circle-check is drawn full-bleed for the todo rows' ring family;
   scaled onto the shared 24-grid here so it matches the sibling glyphs. */
  transform: scale(0.91);
}
/* A user stop is neutral, not a failure — muted glyph, no danger ink. */
.tp-cancelled { color: var(--color-text-muted); }
.tp-fail { color: var(--color-danger); }

.tp-time {
  flex: none;
  font-size: var(--text-base);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-autospace: normal;
}

.tp-model {
  /* Shrinkable so the ellipsis engages against the row's remaining space —
     no ad-hoc width cap (token-governed sizing only). */
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--text-base);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-stop {
  /* Above the open overlay (positioned + later in DOM than it). */
  position: relative;
  flex: none;
  color: var(--color-danger);
}
.tp-stop:hover { color: var(--color-danger); }
/* Touch: the stop meets the 44px minimum hit area (glyph unchanged). */
@media (hover: none) {
  .tp-stop {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
  /* A terminal row has no stop button to stretch it — the open overlay
     still meets the same minimum hit height. */
  .tp-row.expandable > .tp-main {
    min-height: var(--touch-target-min);
  }
}

.tp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
  user-select: none;
}

/* Mobile: two-line rows — the title keeps the first line (time/chevron trail
   it), the recovered command drops to a full-width second line aligned under
   the title, so a long command can no longer crush the name to nothing. */
@media (max-width: 640px) {
  .tp-main { flex-wrap: wrap; row-gap: var(--space-1); }
  .tp-name { font-size: var(--ui-font-size-sm); }
  .tp-meta {
    order: 10;
    flex: 1 1 100%;
    padding-left: calc(var(--p-ic-md) + var(--space-2));
    font-size: var(--ui-font-size-xs);
  }
}
</style>
