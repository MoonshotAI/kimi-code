<!-- packages/app-ui/src/components/ui/ActionCard.vue -->
<!-- Design-system §03 ActionCard: a clickable row card for pick-one choices
     (the OAuth login entries, the custom-provider entry). One semantic = one
     component: leading visual slot, default slot for the title, optional
     `badge` slot (a status Badge, e.g. Recommended) trailing the title,
     `hint` slot for the second line, and a fixed chevron. -->
<script setup lang="ts">
import Icon from './Icon.vue';

withDefaults(defineProps<{
  disabled?: boolean;
}>(), {
  disabled: false,
});

defineEmits<{ select: [] }>();
</script>

<template>
  <button class="ui-action-card" type="button" :disabled="disabled" @click="$emit('select')">
    <span v-if="$slots.leading" class="ui-action-card__leading"><slot name="leading" /></span>
    <span class="ui-action-card__text">
      <span class="ui-action-card__title">
        <slot />
        <slot name="badge" />
      </span>
      <span v-if="$slots.hint" class="ui-action-card__hint"><slot name="hint" /></span>
    </span>
    <Icon name="chevron-right" size="lg" class="ui-action-card__chevron" />
  </button>
</template>

<style scoped>
.ui-action-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4);
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}
.ui-action-card:hover:not(:disabled) {
  border-color: var(--color-line-strong);
  background: var(--color-surface);
}
.ui-action-card:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring-strong);
}
.ui-action-card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ui-action-card__leading {
  align-self: flex-start;
  display: inline-flex;
  flex: none;
}
.ui-action-card__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.ui-action-card__title {
  /* Block, not flex: on narrow screens a long title wraps as continuous
     text and the badge follows the last character instead of floating at
     the first line's right edge. */
  display: block;
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ui-action-card__title :deep(.ui-badge) {
  margin-left: var(--space-2);
  vertical-align: middle;
}
.ui-action-card__hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
}
.ui-action-card__chevron {
  color: var(--color-text-faint);
  flex: none;
}
</style>
