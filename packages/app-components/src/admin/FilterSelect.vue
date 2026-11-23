<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon, Menu, MenuItem, StatusDot } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '@moonshot-ai/app-components';

export interface FilterSelectOption {
  value: string;
  label: string;
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
        <StatusDot v-if="opt.dot" :status="opt.dot === 'done' ? 'archived' : 'ok'" size="lg" />
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
  border: var(--p-hairline) solid var(--color-line);
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
.sa-check {
  display: inline-flex;
  flex: none;
  width: 14px;
}
</style>

<style src="../lib/anchored-menu.css"></style>
