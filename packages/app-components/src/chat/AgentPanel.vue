<script setup lang="ts">
import type { AgentMember, ChatTurn, OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import AgentDetailPanel from './AgentDetailPanel.vue';
import BashTaskPanel from './BashTaskPanel.vue';

const props = defineProps<{
  member: AgentMember | null;
  turns: ChatTurn[];
  running: boolean;
  loading: boolean;
  loadError: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  cwd?: string;
}>();
const emit = defineEmits<{
  loadOlderMessages: [];
  openMedia: [payload: OpenMediaRequest];
}>();
</script>

<template>
  <BashTaskPanel v-if="props.member?.kind === 'bash'" :member="props.member" />
  <AgentDetailPanel
    v-else-if="props.member"
    :member="props.member"
    :turns="props.turns"
    :running="props.running"
    :loading="props.loading"
    :load-error="props.loadError"
    :has-more="props.hasMore"
    :loading-more="props.loadingMore"
    :load-more-error="props.loadMoreError"
    :cwd="props.cwd"
    @load-older-messages="emit('loadOlderMessages')"
    @open-media="emit('openMedia', $event)"
  />
</template>
