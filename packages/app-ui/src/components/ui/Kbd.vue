<!-- apps/kimi-web/src/components/ui/Kbd.vue -->
<!-- Design-system §03 Kbd: keyboard shortcut rendered as keycaps — one <kbd>
     block per key (e.g. ['⌘', 'K'] renders two caps). Keycap look: transparent
     ground + 0.5px hairline, 18px tall to match Badge sm. No fill and no text
     colour of its own — the cap sits on whatever row carries it and follows
     that context's colour. -->
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
  min-width: var(--kbd-min-width);
  height: var(--kbd-height);
  padding: 0 var(--kbd-padding-x);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font-family: var(--font-kbd);
  font-size: var(--kbd-font-size);
  line-height: var(--leading-solid);
}
</style>
