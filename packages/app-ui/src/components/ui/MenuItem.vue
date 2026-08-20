<!-- apps/kimi-web/src/components/ui/MenuItem.vue -->
<!-- Design-system §03 Menu item: supports active / danger / disabled / separator. -->
<script setup lang="ts">
withDefaults(defineProps<{
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** md (desktop) · lg (touch / mobile, ≥44px row). */
  size?: 'md' | 'lg';
  /** `menuitem` inside a Menu (default); `button` in non-menu popovers (e.g. dialogs). */
  /** `menuitemradio` for a mutually exclusive set (pair with aria-checked). */
  role?: 'menuitem' | 'menuitemradio' | 'button';
}>(), { size: 'md', role: 'menuitem' });

defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <div v-if="separator" class="ui-menu-sep" role="separator" />
  <button
    v-else
    class="ui-menu-item"
    :class="[`ui-menu-item--${size}`, { 'is-active': active, 'is-danger': danger }]"
    type="button"
    :role="role"
    :disabled="disabled"
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
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  /* Menu items sit one rung under the base UI step; --text-sm aliases
     calc(--ui-b2 − 1px) on the §03 ramp, so labels still follow the user's
     font scale. */
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: var(--leading-tight);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-base), color var(--duration-base);
}
.ui-menu-item:hover:not(:disabled):not(.is-active):not(.is-danger) { background: var(--color-hover); color: var(--color-text-strong); }
.ui-menu-item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ui-menu-item:disabled { opacity: 0.5; cursor: not-allowed; }
/* "Where I am" selection is the neutral f1 wash, never accent-tinted —
   same recipe as the settings nav (Kimi .ss-nav-item--active → Fills-F1). */
.ui-menu-item.is-active { background: var(--color-hover); color: var(--color-text); }
.ui-menu-item.is-danger { color: var(--color-danger); }
.ui-menu-item.is-danger:hover:not(:disabled) { background: var(--color-danger-soft); }
.ui-menu-item :deep(svg) { display: block; width: 16px; height: 16px; flex: none; color: var(--muted); transition: color var(--duration-base); }
.ui-menu-item:hover:not(:disabled):not(.is-active):not(.is-danger) :deep(svg) { color: var(--color-text-strong); }
.ui-menu-item.is-active :deep(svg) { color: var(--color-text); }
.ui-menu-item.is-danger :deep(svg) { color: var(--color-danger); }
/* lg · touch / mobile: taller row, bigger tap target */
.ui-menu-item--lg { min-height: 44px; padding: 12px 14px; font-size: var(--text-sm); }
.ui-menu-sep { height: 1px; margin: 4px 0; background: var(--color-line); }
</style>
