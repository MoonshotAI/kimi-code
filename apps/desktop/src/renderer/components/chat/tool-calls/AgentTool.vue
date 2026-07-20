<!-- apps/web/src/components/chat/tool-calls/AgentTool.vue -->
<!-- The single-subagent `Agent` tool: a quiet IDENTITY CARD — one per call,
     never folded into a tool group (a delegation has a name and a task, it
     deserves its own weight). The card shows the TASK (the short description)
     as its title and the agent TYPE as a meta line; the orchestrator's full
     prompt stays out of the stream on purpose. The whole card is one action:
     click to open the subagent's live progress in the right-side detail
     panel — there is no in-stream expansion.

     Fallback: when the live task is gone (a completed foreground subagent
     after a page refresh), the side panel has nothing to show, but the saved
     result still lives in `tool.output` — the card then expands in place to
     reveal it instead of going dead. -->
<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, StatusDot } from '@moonshot-ai/web-ui';
import type { ToolCall } from '../../../types';
import { toolLabel } from '../../../lib/toolMeta';
import OutputPanel from './OutputPanel.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{
  /** Open this subagent's live progress in the right-side detail panel. */
  openAgent: [toolCallId: string];
}>();

interface AgentInput {
  description?: string;
  subagentType?: string;
}

function parseAgentInput(arg: string): AgentInput {
  if (!arg) return {};
  try {
    const obj = JSON.parse(arg) as Record<string, unknown>;
    return {
      description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
      subagentType: typeof obj['subagent_type'] === 'string' ? obj['subagent_type'] : undefined,
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

// Disable the side-panel action when no live/background subagent task matches
// this tool call (e.g. a completed foreground subagent after a page refresh) —
// clicking would emit into a panel that silently no-ops.
const resolveAgentTaskId = inject<(toolCallId: string) => string | undefined>('resolveAgentTaskId');
const canOpenAgent = computed(() => {
  if (!resolveAgentTaskId) return true;
  return resolveAgentTaskId(props.tool.id) !== undefined;
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const clickable = computed(() => canOpenAgent.value || hasOutput.value);
const expanded = ref(false);

function onClick(): void {
  if (canOpenAgent.value) {
    emit('openAgent', props.tool.id);
    return;
  }
  // Live task is gone but the result was saved: expand in place to read it.
  if (hasOutput.value) expanded.value = !expanded.value;
}
</script>

<template>
  <div class="agent-card" :class="{ err: status === 'error' }">
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
        <span v-if="agentType" class="type">{{ agentType }}</span>
      </span>
      <span class="tail">
        <span class="st" :class="status" role="status" :aria-label="status">
          <Icon v-if="status === 'ok'" name="check" size="sm" />
          <Icon v-else-if="status === 'error'" name="close" size="sm" />
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
    <div v-if="!canOpenAgent && hasOutput && expanded" class="result">
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
  line-height: 1.4;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.type {
  font-size: var(--text-xs);
  line-height: 1.4;
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

/* Saved-result fallback (no live task): the output panel hangs inside the
   card, separated by the same hairline as the Swarm card's body. */
.result {
  border-top: 0.5px solid var(--color-line);
  padding: var(--space-2) var(--space-3);
}
</style>
