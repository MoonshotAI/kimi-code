<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <span class="worktree-command" :title="text">{{ text }}</span>
</template>

<style scoped>
.worktree-command {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}
</style>
