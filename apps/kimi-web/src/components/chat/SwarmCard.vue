<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AppSubagentPhase } from '../../api/types';
import type { SwarmGroup, SwarmMember } from '../../composables/swarmGroups';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import StatusDot from '../ui/StatusDot.vue';

const props = defineProps<{ group: SwarmGroup }>();

const open = ref(true);

const total = computed(() => props.group.members.length);
const done = computed(() => props.group.counts.completed + props.group.counts.failed);
const running = computed(
  () => props.group.counts.working + props.group.counts.queued + props.group.counts.suspended,
);

type AggregateStatus = 'running' | 'error' | 'done';

const aggregateStatus = computed<AggregateStatus>(() => {
  if (running.value > 0) return 'running';
  if (props.group.counts.failed > 0) return 'error';
  return 'done';
});

const aggregateLabel = computed(() => {
  switch (aggregateStatus.value) {
    case 'running':
      return `${running.value} running`;
    case 'error':
      return 'has failures';
    default:
      return 'completed';
  }
});

function phaseLabel(phase: AppSubagentPhase): string {
  switch (phase) {
    case 'queued':
      return 'Queued';
    case 'working':
      return 'Working';
    case 'suspended':
      return 'Suspended';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
  }
}

function latestProgress(member: SwarmMember): string | undefined {
  return member.outputLines?.map((line) => line.trimEnd()).filter(Boolean).at(-1);
}

function activityText(member: SwarmMember): string | undefined {
  return member.suspendedReason || latestProgress(member) || member.summary;
}

function toggle(): void {
  open.value = !open.value;
}
</script>

<template>
  <section class="swarm-card" :class="{ open }" :id="`swarm-${group.id}`">
    <button class="swarm-head" type="button" :aria-expanded="open" @click="toggle">
      <StatusDot :status="aggregateStatus" />
      <Icon class="swarm-ic" name="git-pull-request" size="sm" />
      <span class="swarm-title">Swarm</span>
      <span class="swarm-meta">· {{ done }}/{{ total }}</span>
      <span class="swarm-meta">· {{ aggregateLabel }}</span>
      <Icon class="swarm-car" name="chevron-right" size="sm" />
    </button>
    <div v-show="open" class="swarm-body">
      <div
        v-for="member in group.members"
        :key="member.id"
        class="swarm-row"
        :class="`phase-${member.phase}`"
      >
        <StatusDot class="row-dot" :status="member.phase" />
        <Tooltip :text="member.name">
          <span class="row-name">{{ member.name }}</span>
        </Tooltip>
        <span v-if="member.subagentType" class="row-type">{{ member.subagentType }}</span>
        <Tooltip :text="activityText(member)">
          <span v-if="activityText(member)" class="row-activity">
            {{ activityText(member) }}
          </span>
        </Tooltip>
        <span class="row-phase">{{ phaseLabel(member.phase) }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.swarm-card {
  margin: 12px 0;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}

/* Operation-card head: 32px, flat, status dot + icon + title + meta + chevron.
   Mirrors ToolGroup.vue so Swarm reads as a background operation, not an
   attention card (no colored band). */
.swarm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 11px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.swarm-head:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.swarm-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}
.swarm-ic {
  color: var(--color-text-faint);
  flex: none;
}
.swarm-title {
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.swarm-meta {
  color: var(--color-text-faint);
}
.swarm-car {
  margin-left: auto;
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.swarm-card.open .swarm-car {
  transform: rotate(90deg);
}

/* Stacked rows: the card owns the outer border, rows are flat and separated by
   a 1px hairline — design-system §04 grouping. */
.swarm-body {
  display: flex;
  flex-direction: column;
}
.swarm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 7px 11px;
  border-top: 1px solid var(--color-line);
  color: var(--color-text);
}
.row-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.row-type {
  flex: none;
  color: var(--color-text-faint);
  font: var(--text-xs) var(--font-mono);
}
.row-activity {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.row-phase {
  flex: none;
  margin-left: auto;
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-faint);
}

/* Phase label color matches the dot for quick scanning. */
.phase-completed .row-phase { color: var(--color-success); }
.phase-failed .row-phase { color: var(--color-danger); }
.phase-working .row-phase { color: var(--color-accent); }
.phase-suspended .row-phase { color: var(--color-warning); }
.phase-queued .row-phase { color: var(--color-text-faint); }
</style>
