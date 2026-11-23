<script setup lang="ts">
withDefaults(defineProps<{
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  size?: 'md' | 'lg';
  role?: 'menuitem' | 'menuitemradio' | 'button' | 'option';
  hasPopup?: 'menu' | 'dialog';
  expanded?: boolean;
}>(), { size: 'md', role: 'menuitem' });

defineEmits<{ click: [event: MouseEvent] }>();
const slots = defineSlots<{
  default?: () => unknown;
  action?: () => unknown;
}>();
</script>

<template>
  <div v-if="separator" class="ui-menu-sep" role="separator" />
  <div
    v-else-if="slots.action"
    class="ui-menu-item-row"
    :class="{ 'is-active': active, 'is-disabled': disabled }"
    role="none"
  >
    <button
      class="ui-menu-item"
      :class="[`ui-menu-item--${size}`, { 'is-active': active, 'is-danger': danger }]"
      type="button"
      :role="role"
      :disabled="disabled"
      :aria-haspopup="hasPopup"
      :aria-expanded="expanded"
      @click="$emit('click', $event)"
    >
      <slot />
    </button>
    <span class="ui-menu-item__action">
      <slot name="action" />
    </span>
  </div>
  <button
    v-else
    class="ui-menu-item"
    :class="[`ui-menu-item--${size}`, { 'is-active': active, 'is-danger': danger }]"
    type="button"
    :role="role"
    :disabled="disabled"
    :aria-haspopup="hasPopup"
    :aria-expanded="expanded"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-menu-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: var(--menu-item-padding-block) var(--menu-item-padding-inline);
  border: none;
  border-radius: var(--radius-menu-item);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: round(calc(var(--text-sm) * var(--leading-tight)), 1px);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-base), color var(--duration-base);
}
.ui-menu-item:hover:not(:disabled):not(.is-active):not(.is-danger) { background: var(--color-hover); color: var(--color-text-strong); }
.ui-menu-item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-menu-item:disabled { opacity: 0.5; cursor: not-allowed; }
.ui-menu-item.is-active { background: var(--color-hover); color: var(--color-text); }
.ui-menu-item.is-danger { color: var(--color-danger); }
.ui-menu-item.is-danger:hover:not(:disabled) { background: var(--color-hover); }
.ui-menu-item :deep(svg) { display: block; width: 16px; height: 16px; flex: none; color: var(--color-text-faint); transition: color var(--duration-base); }
.ui-menu-item:hover:not(:disabled):not(.is-active):not(.is-danger) :deep(svg) { color: var(--color-text-strong); }
.ui-menu-item.is-active :deep(svg) { color: var(--color-text); }
.ui-menu-item.is-danger :deep(svg) { color: var(--color-danger); }
.ui-menu-item--lg { min-height: 44px; padding: 12px 14px; font-size: var(--text-sm); }
.ui-menu-item-row {
  display: flex;
  align-items: center;
  border-radius: var(--radius-menu-item);
  transition: background var(--duration-base);
}
.ui-menu-item-row > .ui-menu-item { flex: 1; min-width: 0; }
.ui-menu-item-row:hover:not(.is-disabled),
.ui-menu-item-row.is-active { background: var(--color-hover); }
.ui-menu-item-row > .ui-menu-item:hover:not(:disabled):not(.is-active):not(.is-danger),
.ui-menu-item-row > .ui-menu-item.is-active { background: transparent; }
.ui-menu-item__action {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding-inline-end: var(--space-1);
}
.ui-menu-item__action:empty { display: none; }
.ui-menu-sep { height: 1px; margin: 4px 0; background: var(--color-line); }
</style>
