<!-- The single-subagent `Agent` tool: a quiet IDENTITY CARD — one per call,
     never folded into a tool group (a delegation has a name and a task, it
     deserves its own weight). The card shows the TASK (the short description)
     as its title and a meta line with the agent TYPE plus the bound MODEL
     (when the server reports it); the orchestrator's full
     prompt stays out of the stream on purpose. The whole card is one action:
     click to open the subagent's live progress in the right-side detail
     panel — there is no in-stream expansion.

     Historical calls use their persisted child agent id to cold-resume the
     transcript. Saved output remains available as a fallback when the
     transcript cannot be restored.

     BACKGROUND calls return at spawn time, so their own call status would
     flash a premature ✓ while the task still runs: the status icon binds the
     task's live state (blue dot → ✓/✗ at the task's real terminal), falling
     back to the call status only when the task row is gone. -->
<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, StatusDot } from '@moonshot-ai/app-ui';
import type { ToolCall } from '../../../types';
import { toolLabel } from '../../../lib/toolMeta';
import OutputPanel from './OutputPanel.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{
  /** Open this subagent in the right-side detail panel. */
  openAgent: [target: string];
}>();

interface AgentInput {
  description?: string;
  subagentType?: string;
  runInBackground?: boolean;
}

function parseAgentInput(arg: string): AgentInput {
  if (!arg) return {};
  try {
    const obj = JSON.parse(arg) as Record<string, unknown>;
    return {
      description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
      subagentType: typeof obj['subagent_type'] === 'string' ? obj['subagent_type'] : undefined,
      runInBackground: obj['run_in_background'] === true,
    };
  } catch {
    return {};
  }
}

const input = computed(() => parseAgentInput(props.tool.arg));
const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

// Title = the task at a glance ("分析双引擎架构"); meta = the agent type.
// With no description the type promotes to the title and the meta line drops.
const task = computed(() => input.value.description || input.value.subagentType || toolLabel(props.tool.name));
const agentType = computed(() => (input.value.description ? input.value.subagentType : ''));

const resolveAgentTaskId = inject<(toolCallId: string) => string | undefined>('resolveAgentTaskId');
const resolveAgentModel = inject<
  (toolCallId: string, agentId?: string) => { display?: string; effort?: string } | undefined
>('resolveAgentModel');
const agentTarget = computed(
  () => props.tool.agentId ?? resolveAgentTaskId?.(props.tool.id),
);
const canOpenAgent = computed(() => agentTarget.value !== undefined);
const resolveAgentTaskState = inject<
  (
    toolCallId: string,
    agentId: string | undefined,
  ) => 'run' | 'done' | 'fail' | 'cancelled' | undefined
>('resolveAgentTaskState');
// Background only: the icon tells the TASK's truth, not the spawn call's.
const taskState = computed(() =>
  input.value.runInBackground
    ? resolveAgentTaskState?.(props.tool.id, agentTarget.value)
    : undefined,
);
const displayStatus = computed<'running' | 'ok' | 'error' | 'cancelled'>(() => {
  const ts = taskState.value;
  if (ts === 'run') return 'running';
  if (ts === 'done') return 'ok';
  if (ts === 'fail') return 'error';
  // Cancelled stays NEUTRAL (the user stopped it on purpose) — not an error.
  if (ts === 'cancelled') return 'cancelled';
  return status.value;
});
const statusLabel = computed(() => t(`tools.agent.status.${displayStatus.value}`));

// Meta line: 前台/后台 · agent type · bound model (friendly name) · effort
// (concrete levels only; boolean on/off hidden). The run_in_background arg
// defaults to foreground when omitted. Absent for history rows whose
// lifecycle events predate the session load. The resolved agent id goes
// along so restored rows keyed by agent id still resolve.
const boundModel = computed(() => resolveAgentModel?.(props.tool.id, agentTarget.value));
const meta = computed(() =>
  [
    input.value.runInBackground ? t('tools.agent.background') : t('tools.agent.foreground'),
    agentType.value,
    boundModel.value?.display,
    boundModel.value?.effort,
  ]
    .filter((part) => part)
    .join(' · '),
);

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const clickable = computed(() => canOpenAgent.value || hasOutput.value);
const expanded = ref(false);

function onClick(): void {
  if (agentTarget.value !== undefined) {
    emit('openAgent', agentTarget.value);
    return;
  }
  // Live task is gone but the result was saved: expand in place to read it.
  if (hasOutput.value) expanded.value = !expanded.value;
}
</script>

<template>
  <div class="agent-card" :class="{ err: displayStatus === 'error' }">
    <button
      class="head"
      type="button"
      :disabled="!clickable"
      :aria-label="canOpenAgent ? t('tasks.openDetail') : undefined"
      :aria-expanded="canOpenAgent ? undefined : expanded"
      @click="onClick"
    >
      <span class="lead" aria-hidden="true"><Icon name="robot" size="sm" /></span>
      <span class="main">
        <span class="task">{{ task }}</span>
        <span v-if="meta" class="type">{{ meta }}</span>
      </span>
      <span class="tail">
        <span class="st" :class="displayStatus" role="status" :aria-label="statusLabel">
          <Icon v-if="displayStatus === 'ok'" name="check" size="sm" />
          <Icon v-else-if="displayStatus === 'error'" name="close" size="sm" />
          <Icon v-else-if="displayStatus === 'cancelled'" name="close" size="sm" />
          <StatusDot v-else status="running" />
        </span>
        <Icon v-if="canOpenAgent" class="go" name="arrow-right" size="sm" aria-hidden="true" />
        <Icon
          v-else-if="hasOutput"
          class="go car"
          :class="{ open: expanded }"
          name="chevron-right"
          size="sm"
          aria-hidden="true"
        />
      </span>
    </button>
    <button
      v-if="canOpenAgent && hasOutput"
      class="saved-result"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <Icon
        class="saved-result__chevron"
        :class="{ open: expanded }"
        name="chevron-right"
        size="sm"
        aria-hidden="true"
      />
      <span>{{ t('tools.output.saved') }}</span>
    </button>
    <div
      v-if="hasOutput && expanded"
      class="result"
      :class="{ 'result--legacy': !canOpenAgent }"
    >
      <OutputPanel :lines="tool.output" />
    </div>
  </div>
</template>

<style scoped>
/* Identity card: the Swarm card's quiet shell vocabulary — raised surface,
   0.5px hairline, large radius, no shadow. The head row is the action. */
.agent-card {
  margin: var(--space-1) 0;
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color var(--duration-base) var(--ease-out);
}
.agent-card:hover {
  border-color: var(--color-line-strong);
}
.agent-card.err {
  border-color: color-mix(in srgb, var(--color-danger) 45%, var(--bg));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.head:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.head:disabled {
  cursor: default;
}

/* Glyph in a small sunken badge — the card's identity mark. */
.lead {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  flex: none;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.task {
  font-size: var(--ui-font-size);
  line-height: var(--leading-caption);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.type {
  font-size: var(--text-xs);
  line-height: var(--leading-caption);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.st {
  display: inline-flex;
  align-items: center;
}
.st.ok {
  color: var(--color-success);
}
.st.error {
  color: var(--color-danger);
}
.st.cancelled {
  color: var(--color-text-faint);
}
.go {
  color: var(--color-text-faint);
  transition: color var(--duration-base) var(--ease-out);
}
.agent-card:hover .head:not(:disabled) .go {
  color: var(--color-text);
}
.go.car {
  transition:
    color var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.go.car.open {
  transform: rotate(90deg);
}

.saved-result {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-top: 0.5px solid var(--color-line);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}
.saved-result:hover {
  color: var(--color-text-muted);
}
.saved-result:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.saved-result__chevron {
  transition: transform var(--duration-base) var(--ease-out);
}
.saved-result__chevron.open {
  transform: rotate(90deg);
}

.result {
  padding: var(--space-2) var(--space-3);
}
.result--legacy {
  border-top: 0.5px solid var(--color-line);
}
</style>
