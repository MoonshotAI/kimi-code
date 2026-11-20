<script setup lang="ts">
import { computed } from 'vue';
import { pullRequestStateKey, pullRequestStateLabel } from './sessionDirectoryDisplay';

const props = defineProps<{
  state: string;
}>();

const key = computed(() => pullRequestStateKey(props.state));
const label = computed(() => pullRequestStateLabel(props.state));
</script>

<template>
  <span class="spr-state" :class="`pr-${key}`">{{ label }}</span>
</template>

<style scoped>
.spr-state { flex: none; padding: 0 var(--space-1-5); border: var(--p-hairline) solid transparent; border-radius: var(--radius-full); font-family: var(--font-ui); font-size: 11px; line-height: 16px; }
.spr-state.pr-open { color: var(--color-success); background: var(--color-success-soft); border-color: var(--color-success-bd); }
.spr-state.pr-merged { color: var(--color-done); background: var(--color-done-soft); border-color: var(--color-done-bd); }
.spr-state.pr-closed { color: var(--color-danger); background: var(--color-danger-soft); border-color: var(--color-danger-bd); }
.spr-state.pr-draft,
.spr-state.pr-unknown { color: var(--color-text-muted); background: var(--color-well); border-color: var(--color-line); }
</style>
