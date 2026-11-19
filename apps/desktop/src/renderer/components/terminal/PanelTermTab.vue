<script setup lang="ts">
import type { SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import TerminalView from './TerminalView.vue';

defineOptions({ name: 'PanelTermTab' });

const props = defineProps<{
  ptyId: string | null;
  error: string | null;
  active: boolean;
}>();
const emit = defineEmits<{
  quoteAction: [payload: SelectionActionPayload];
}>();
</script>

<template>
  <div class="ptt">
    <TerminalView
      v-if="props.ptyId !== null"
      :tab-id="props.ptyId"
      :active="props.active"
      panel-host
      @quote-action="emit('quoteAction', $event)"
    />
    <div v-else class="ptt-error">{{ props.error }}</div>
  </div>
</template>

<style scoped>
.ptt {
  position: relative;
  height: 100%;
  min-height: 0;
  background: var(--color-bg);
  border-bottom: var(--pfc-host-h, 0px) solid transparent;
}
.ptt-error {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  color: var(--color-danger);
  font-size: var(--text-sm);
  text-align: center;
  user-select: text;
}
</style>
