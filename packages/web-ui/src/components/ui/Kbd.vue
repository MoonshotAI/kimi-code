<!-- apps/kimi-web/src/components/ui/Kbd.vue -->
<!-- Design-system §03 Kbd: keyboard shortcut rendered as keycaps — one <kbd>
     block per key (e.g. ['⌘', 'K'] renders two caps). Keycap look: sunken
     surface + 2px bottom border, 18px tall to match Badge sm. -->
<script setup lang="ts">
defineProps<{
  keys: string[];
}>();
</script>

<template>
  <span class="ui-kbd">
    <kbd v-for="key in keys" :key="key" class="ui-kbd__key">{{ key }}</kbd>
  </span>
</template>

<style scoped>
.ui-kbd {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.ui-kbd__key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--color-line);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: 11px;
  line-height: 1;
}
</style>
