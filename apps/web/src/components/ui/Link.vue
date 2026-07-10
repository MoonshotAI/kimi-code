<!-- apps/kimi-web/src/components/ui/Link.vue -->
<!-- Design-system §03 Link: inline text link. -->
<script setup lang="ts">
withDefaults(defineProps<{
  href?: string;
  variant?: 'default' | 'muted';
  external?: boolean;
}>(), {
  variant: 'default',
});
</script>

<template>
  <a
    v-if="href"
    class="ui-link"
    :class="`ui-link--${variant}`"
    :href="href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
  ><slot /></a>
  <span v-else class="ui-link" :class="`ui-link--${variant}`"><slot /></span>
</template>

<style scoped>
.ui-link {
  color: var(--color-accent);
  text-decoration: none;
  cursor: pointer;
  font: inherit;
  transition: color var(--duration-base) var(--ease-out);
}
.ui-link:hover { color: var(--color-accent-hover); text-decoration: underline; }
.ui-link:focus-visible { outline: none; box-shadow: var(--p-focus-ring); border-radius: var(--radius-xs); }
.ui-link--muted { color: var(--color-text-muted); }
.ui-link--muted:hover { color: var(--color-text); }
</style>
