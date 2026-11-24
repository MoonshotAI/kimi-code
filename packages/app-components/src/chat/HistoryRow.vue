<script setup lang="ts">
import { provide } from 'vue';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';

const props = defineProps<{ state: Map<string, unknown> }>();
provide(HistoryStateKey, props.state);
</script>

<template>
  <div class="history-row"><slot /></div>
</template>

<style scoped>
.history-row {
  display: flow-root;
  min-width: 0;
  overflow-anchor: none;
}
</style>
