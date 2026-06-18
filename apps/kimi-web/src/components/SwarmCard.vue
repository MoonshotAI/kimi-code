<script setup lang="ts">
import { computed } from 'vue';
import type { AppSubagentPhase } from '../api/types';
import type { SwarmGroup, SwarmMember } from '../composables/swarmGroups';

const props = defineProps<{ group: SwarmGroup }>();

const total = computed(() => props.group.members.length);
const done = computed(() => props.group.counts.completed + props.group.counts.failed);

function phaseLabel(phase: AppSubagentPhase): string {
  switch (phase) {
    case 'queued': return 'Queued';
    case 'working': return 'Working';
    case 'suspended': return 'Suspended';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

function bar(member: SwarmMember): string {
  switch (member.phase) {
    case 'queued': return '......';
    case 'working': return ':::...';
    case 'suspended': return '::....';
    case 'completed': return '::::::';
    case 'failed': return '!!....';
  }
}

function latestProgress(member: SwarmMember): string | undefined {
  return member.outputLines?.map((line) => line.trimEnd()).filter(Boolean).at(-1);
}
</script>

<template>
  <section class="swarm-card" :id="`swarm-${group.id}`">
    <header class="swarm-head">
      <div class="swarm-title">
        <span class="swarm-mark" aria-hidden="true"></span>
        <span>Swarm</span>
      </div>
      <div class="swarm-count">{{ done }}/{{ total }}</div>
    </header>
    <div class="swarm-grid">
      <article
        v-for="member in group.members"
        :key="member.id"
        class="swarm-member"
        :class="`phase-${member.phase}`"
      >
        <div class="member-top">
          <span class="member-name">{{ member.name }}</span>
          <span class="member-phase">{{ phaseLabel(member.phase) }}</span>
        </div>
        <div class="member-mid">
          <span class="member-bar">{{ bar(member) }}</span>
          <span v-if="member.subagentType" class="member-type">{{ member.subagentType }}</span>
        </div>
        <div v-if="member.suspendedReason || latestProgress(member) || member.summary" class="member-bottom">
          {{ member.suspendedReason || latestProgress(member) || member.summary }}
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.swarm-card {
  margin: 12px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.swarm-head {
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
}
.swarm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 750;
  color: var(--ink);
}
.swarm-mark {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 0 0 4px var(--bluebg);
}
.swarm-count {
  border-radius: 999px;
  padding: 2px 8px;
  background: var(--soft);
  color: var(--blue2);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
}
.swarm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
  gap: 8px;
  padding: 10px;
}
.swarm-member {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  padding: 8px 9px;
}
.member-top,
.member-mid {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.member-top {
  justify-content: space-between;
}
.member-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 650;
}
.member-phase,
.member-type {
  flex: none;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.member-mid {
  margin-top: 6px;
  justify-content: space-between;
}
.member-bar {
  color: var(--blue2);
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  letter-spacing: 0;
}
.phase-completed .member-bar { color: var(--ok); }
.phase-failed .member-bar { color: var(--err); }
.phase-suspended .member-bar { color: var(--warn); }
.phase-queued .member-bar { color: var(--muted); }
.member-bottom {
  min-width: 0;
  margin-top: 7px;
  color: var(--dim);
  font-size: calc(var(--ui-font-size) - 2.5px);
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
