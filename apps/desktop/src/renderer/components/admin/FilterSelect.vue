<!-- Quiet single-select for the session admin filter bar / pager (status,
     page size): a hairline trigger button + anchored Menu with a leading
     check slot and an optional status dot per option. Page-private — the
     app-ui Select is a form control (accent focus ring, no dots), while the
     admin filter bar follows the prototype's quiet dropdown language. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from './useAnchoredMenu';

export interface FilterSelectOption {
  value: string;
  label: string;
  /** Status dot colour (lifecycle semantics): open = success, done = done. */
  dot?: 'open' | 'done';
}

const props = defineProps<{
  modelValue: string;
  options: FilterSelectOption[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, toggle, close } = useAnchoredMenu(menuRef);

// The filter bar's Enter-to-query guard reads whether any overlay is open.
defineExpose({ open });

const displayLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? '',
);

function pick(value: string): void {
  if (value !== props.modelValue) emit('update:modelValue', value);
  close();
}
</script>

<template>
  <button
    class="sa-select"
    :class="{ 'is-open': open }"
    type="button"
    :aria-label="ariaLabel"
    @click="toggle"
  >
    <span class="sa-select-label">{{ displayLabel }}</span>
    <Icon class="sa-select-chev" name="chevron-down" size="sm" />
  </button>
  <Transition name="menu-pop">
    <Menu v-if="open" ref="menuRef" class="sa-menu" :style="menuStyle" @click.stop>
      <MenuItem v-for="opt in options" :key="opt.value" @click="pick(opt.value)">
        <span class="sa-check">
          <Icon v-if="opt.value === modelValue" name="check" size="sm" />
        </span>
        <span v-if="opt.dot" class="sa-dot" :class="`sa-dot--${opt.dot}`" />
        {{ opt.label }}
      </MenuItem>
    </Menu>
  </Transition>
</template>

<style scoped>
.sa-select {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 30px;
  padding: 0 var(--space-3);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  line-height: 1;
  white-space: nowrap;
  transition: background var(--duration-fast) var(--ease-out);
}
.sa-select:hover,
.sa-select.is-open {
  background: var(--color-hover);
}
.sa-select-chev {
  color: var(--color-text-faint);
}

.sa-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
/* Leading check slot — fixed width so unchecked rows keep the text aligned. */
.sa-check {
  display: inline-flex;
  flex: none;
  width: 14px;
}
.sa-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}
.sa-dot--open {
  background: var(--color-success);
}
.sa-dot--done {
  background: var(--color-done);
}

/* Menu enter/exit — pops out of the trigger corner (Sidebar menu language). */
.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
