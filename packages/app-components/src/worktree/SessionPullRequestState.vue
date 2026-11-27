<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@moonshot-ai/app-ui';
import { pullRequestStateKey, pullRequestStateLabel } from './sessionDirectoryDisplay';

const props = defineProps<{
  state: string;
}>();

const key = computed(() => pullRequestStateKey(props.state));
const label = computed(() => pullRequestStateLabel(props.state));
const variant = computed(() => {
  if (key.value === 'open') return 'success';
  if (key.value === 'closed') return 'danger';
  return 'neutral';
});
</script>

<template>
  <Badge class="spr-state" :class="`pr-${key}`" size="sm" :variant="variant">{{ label }}</Badge>
</template>

<style scoped>
.spr-state { flex: none; }
.spr-state.pr-merged { color: var(--color-done); background: var(--color-done-soft); border-color: var(--color-done-bd); }
</style>
