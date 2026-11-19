<script setup lang="ts">
import { watch } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';
import { useHistoryState } from '../../historyState';

const props = withDefaults(defineProps<{ stateKey: string; label: string; meta?: string; initiallyOpen?: boolean }>(), {
  meta: '',
  initiallyOpen: false,
});

const open = useHistoryState(props.stateKey, props.initiallyOpen);
watch(() => props.initiallyOpen, (next) => {
  if (next) open.value = true;
});
</script>

<template>
  <div class="bfold">
    <button class="bfold-head" type="button" :aria-expanded="open" @click="open = !open">
      <Icon class="bfold-car" :class="{ open }" name="chevron-right" size="sm" aria-hidden="true" />
      <span class="bfold-label">{{ label }}</span>
      <span v-if="meta" class="bfold-meta">{{ meta }}</span>
    </button>
    <div v-if="open" class="bfold-body"><slot /></div>
  </div>
</template>

<style scoped>
.bfold {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.bfold-head {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--space-1);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: 20px;
  cursor: pointer;
  user-select: none;
}
.bfold-head:hover {
  color: var(--color-text);
}
.bfold-head:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.bfold-car {
  color: var(--color-text-faint);
  transition: transform var(--duration-base) var(--ease-out);
}
.bfold-car.open {
  transform: rotate(90deg);
}
.bfold-meta {
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}
.bfold-body {
  min-width: 0;
}
@media (prefers-reduced-motion: reduce) {
  .bfold-car {
    transition: none;
  }
}
</style>
