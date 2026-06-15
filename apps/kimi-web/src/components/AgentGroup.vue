<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentMember } from '../types';
import AgentCard from './AgentCard.vue';

const props = defineProps<{ members: AgentMember[] }>();

const emit = defineEmits<{
  /** Forwarded from a child card: open that subagent's detail on the right. */
  open: [memberId: string];
}>();

const expanded = ref(true);

const done = computed(() =>
  props.members.filter((m) => m.phase === 'completed' || m.phase === 'failed').length,
);

const running = computed(() =>
  props.members.filter((m) => m.phase === 'queued' || m.phase === 'working' || m.phase === 'suspended').length,
);
</script>

<template>
  <section class="agent-group">
    <button class="group-head" type="button" @click="expanded = !expanded">
      <span class="group-title">Agents</span>
      <span class="group-count">{{ done }}/{{ members.length }}</span>
      <span v-if="running > 0" class="group-live">{{ running }} running</span>
      <svg
        class="group-chevron"
        :class="{ open: expanded }"
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
    <div v-if="expanded" class="group-body">
      <AgentCard v-for="member in members" :key="member.id" :member="member" compact @open="emit('open', $event)" />
    </div>
  </section>
</template>

<style scoped>
.agent-group {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.group-head {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  background: var(--panel2);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.group-title {
  font-weight: 700;
  font-size: var(--ui-font-size-sm);
}
.group-count {
  border-radius: 999px;
  padding: 1px 7px;
  background: var(--soft);
  color: var(--blue2);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
}
.group-live {
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
}
.group-chevron {
  margin-left: auto;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--muted);
  transition: transform 0.12s;
}
.group-chevron.open {
  transform: rotate(90deg);
}
.group-body {
  display: grid;
  gap: 8px;
  padding: 10px;
}
</style>
