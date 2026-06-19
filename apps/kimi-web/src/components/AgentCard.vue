<script setup lang="ts">
import { computed } from 'vue';
import type { AgentMember } from '../types';

const props = defineProps<{ member: AgentMember; compact?: boolean }>();

const emit = defineEmits<{
  /** Open this subagent's full detail in the right-side panel. */
  open: [memberId: string];
}>();

const progressLines = computed(() =>
  (props.member.outputLines ?? [])
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-8),
);
const latestProgress = computed(() => progressLines.value.at(-1));
const livePhase = computed(() =>
  props.member.phase === 'queued' || props.member.phase === 'working' || props.member.phase === 'suspended',
);
const hasDetail = computed(() =>
  Boolean(props.member.summary || props.member.suspendedReason || props.member.prompt || progressLines.value.length > 0),
);

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return 'Queued';
    case 'working': return 'Working';
    case 'suspended': return 'Suspended';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

function open(): void {
  if (hasDetail.value) emit('open', props.member.id);
}
</script>

<template>
  <div class="agent-card" :class="[`phase-${member.phase}`, { compact }]">
    <button class="agent-head" type="button" :disabled="!hasDetail" @click="open">
      <span class="agent-dot" aria-hidden="true"></span>
      <span class="agent-main">
        <span class="agent-title-row">
          <span class="agent-name">{{ member.name }}</span>
          <span v-if="member.subagentType" class="agent-type">{{ member.subagentType }}</span>
          <!-- The "currently doing" line shares the title row, filling the blank
               space to its right; it never wraps onto its own line. -->
          <span
            v-if="livePhase"
            class="agent-live"
            :class="{ empty: !latestProgress }"
          >{{ latestProgress }}</span>
        </span>
      </span>
      <span class="agent-phase">{{ phaseLabel(member.phase) }}</span>
      <svg
        v-if="hasDetail"
        class="agent-chevron"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.agent-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.agent-card.compact {
  border-radius: 6px;
}
.agent-head {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
}
.agent-head:not(:disabled) {
  cursor: pointer;
}
.agent-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--blue);
  flex: none;
}
.phase-completed .agent-dot { background: var(--ok); }
.phase-failed .agent-dot { background: var(--err); }
.phase-suspended .agent-dot { background: var(--warn); }
.phase-queued .agent-dot { background: var(--muted); }
.agent-main {
  min-width: 0;
  flex: 1;
}
.agent-title-row {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
  overflow: hidden;
}
.agent-name {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ui-font-size-sm);
  font-weight: 650;
}
.agent-type {
  flex: none;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
}
.agent-live {
  flex: 1 1 120px;
  min-width: 0;
  max-width: min(55%, 520px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
}
.agent-live.empty {
  visibility: hidden;
}
.agent-phase {
  flex: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--dim);
  background: var(--bg);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.agent-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--muted);
}
</style>
