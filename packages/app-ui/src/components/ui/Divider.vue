<script setup lang="ts">
defineProps<{ vertical?: boolean }>();
</script>

<template>
  <hr v-if="!vertical" class="ui-divider" />
  <span v-else class="ui-divider-v" aria-hidden="true" />
</template>

<style scoped>
.ui-divider { border: none; border-top: var(--p-hairline) solid var(--color-line); margin: 0; }
.ui-divider-v { display: inline-block; width: 1px; min-height: 1em; align-self: stretch; background: var(--color-line); vertical-align: middle; }
</style>
