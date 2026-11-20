<script setup lang="ts">
import { Icon } from '@moonshot-ai/app-ui';

defineProps<{
  title: string;
  collapsed: boolean;
  toggleLabel: string;
  labelClass?: string;
  headingClass?: string;
  titleClass?: string;
  toggleClass?: string;
  collapsedToggleClass?: string;
  actionsClass?: string;
}>();

const emit = defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <div class="sb-sec-label" :class="labelClass">
    <div class="sb-sec-heading" :class="headingClass" @click.stop="emit('toggle')">
      <span class="sb-sec-title" :class="titleClass">{{ title }}</span>
      <button
        type="button"
        class="sb-sec-fold"
        :class="[toggleClass, collapsed && ['sb-sec-fold--on', collapsedToggleClass]]"
        :aria-expanded="!collapsed"
        :aria-label="toggleLabel"
        @click.stop="emit('toggle')"
      >
        <Icon name="chevron-down" />
      </button>
    </div>
    <div class="sb-sec-actions" :class="actionsClass">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.sb-sec-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-inline: var(--space-2) var(--sb-action-inset);
  padding-block-end: var(--space-1);
  font: var(--weight-section-label) var(--text-xs) var(--font-ui);
  text-transform: uppercase;
  color: var(--faint);
  user-select: none;
}

.sb-sec-heading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-05);
  min-width: 0;
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}

.sb-sec-heading:hover {
  color: var(--dim);
}

.sb-sec-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-sec-fold {
  appearance: none;
  display: inline-grid;
  place-items: center;
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}

.sb-sec-label:hover .sb-sec-fold,
.sb-sec-heading:focus-within .sb-sec-fold,
.sb-sec-fold--on {
  opacity: 1;
}

.sb-sec-fold:hover {
  color: var(--color-text-muted);
}

.sb-sec-fold:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.sb-sec-fold svg {
  inline-size: 12px;
  block-size: 12px;
  transition: transform var(--duration-base) var(--ease-out);
}

.sb-sec-fold--on svg {
  transform: rotate(-90deg);
}

.sb-sec-actions {
  margin-inline-start: auto;
  display: flex;
  align-items: center;
  gap: var(--space-05);
  flex: none;
}

@media (prefers-reduced-motion: reduce) {
  .sb-sec-fold svg {
    transition: none;
  }
}
</style>
