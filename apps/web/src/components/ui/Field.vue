<!-- apps/kimi-web/src/components/ui/Field.vue -->
<!-- Design-system §03 Field: label + control slot + hint / error message. -->
<script setup lang="ts">
defineProps<{
  label?: string;
  hint?: string;
  error?: string;
}>();
</script>

<template>
  <div class="ui-field" :class="{ 'has-error': !!error }">
    <label v-if="label" class="ui-field__label">{{ label }}</label>
    <slot />
    <span v-if="error" class="ui-field__error">{{ error }}</span>
    <span v-else-if="hint" class="ui-field__hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.ui-field { display: flex; flex-direction: column; gap: 6px; }
.ui-field__label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.ui-field__hint { font-size: var(--text-xs); color: var(--color-text-faint); }
.ui-field__error { font-size: var(--text-xs); color: var(--color-danger); }
</style>
