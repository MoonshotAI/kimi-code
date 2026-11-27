<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <pre class="worktree-output" tabindex="0">{{ text }}</pre>
</template>

<style scoped>
:where(.worktree-output) {
  margin: 0;
}
.worktree-output {
  --worktree-output-line: calc(var(--text-xs) * var(--leading-normal));
  box-sizing: border-box;
  min-width: 0;
  max-height: calc(5 * var(--worktree-output-line) + 2 * var(--space-2));
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  overscroll-behavior: contain;
  border-radius: var(--radius-md);
  background: var(--color-well);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--worktree-output-line);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.worktree-output:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
