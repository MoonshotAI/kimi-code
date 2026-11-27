<script setup lang="ts">
defineProps<{ label: string; muted?: boolean }>();
</script>

<template>
  <span class="ui-metric-badge" :class="{ 'is-muted': muted }"><span class="ui-metric-label">{{ label }}</span><span class="ui-metric-value"><slot /></span></span>
</template>

<style scoped>
.ui-metric-badge { display: inline-flex; border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-xs); overflow: hidden; font-size: var(--text-xs); line-height: var(--leading-normal); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ui-metric-label, .ui-metric-value { padding-inline: var(--space-1); }
.ui-metric-label { color: var(--color-text-muted); font-weight: var(--weight-section-label); background: var(--color-surface-sunken); border-right: var(--p-hairline) solid var(--color-line); }
.is-muted { color: var(--color-text-muted); border-color: var(--color-subtle); }
.is-muted .ui-metric-label { font-weight: var(--weight-regular); border-color: var(--color-subtle); }
</style>
